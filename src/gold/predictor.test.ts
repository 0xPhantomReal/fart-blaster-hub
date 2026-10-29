import { describe, expect, it } from "vitest";
import { Predictor, SUPPORT_NEEDED } from "./predictor";
import type { Candle } from "./indicators";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Candles where `fade` of big candles are followed by the opposite color (0.5 = no pattern). */
function candles(n: number, fade: number, seed = 7): Candle[] {
  const r = rng(seed);
  const out: Candle[] = [];
  let price = 4000;
  let prevBig = 0;
  for (let i = 0; i < n; i++) {
    const big = r() < 0.12;
    const pGreen = prevBig === 1 ? 1 - fade : prevBig === -1 ? fade : 0.5;
    const dir = r() < pGreen ? 1 : -1;
    const range = (big ? 3 : 1) * (0.8 + r() * 0.4);
    const body = range * (0.5 + r() * 0.3);
    const open = price;
    const close = open + dir * body;
    const spare = range - body;
    const u = r();
    out.push({ time: 1_700_000_100 - (1_700_000_100 % 900) + i * 900, open, close, high: Math.max(open, close) + spare * u, low: Math.min(open, close) - spare * (1 - u) });
    price = close;
    prevBig = big ? dir : 0;
  }
  return out;
}

const run = (cs: Candle[]) => {
  const p = new Predictor(900);
  for (const c of cs) p.close(c);
  return p.summary();
};

describe("next-candle predictor", () => {
  it("finds a real pattern and its calls beat a coin flip", () => {
    const s = run(candles(6000, 0.8));
    console.log(`planted pattern: ${s.model.calls} calls, ${(s.model.hitRate! * 100).toFixed(1)}% right, skill ${s.model.skill!.toFixed(3)}`);
    expect(s.model.hitRate!).toBeGreaterThan(0.56);
    expect(s.model.skill!).toBeGreaterThan(0.02);
  });

  it("shows no skill on random candles", () => {
    for (const seed of [1, 2, 3]) expect(run(candles(6000, 0.5, seed)).model.skill!).toBeLessThan(0.01);
  });

  it("never looks ahead: a prediction is fixed before its candle is seen", () => {
    const cs = candles(800, 0.8);
    const a = new Predictor(900);
    let pred = null;
    for (const c of cs) pred = a.close(c).next;
    const t = cs[cs.length - 1];
    const before = JSON.stringify(pred);
    a.close({ time: t.time + 900, open: t.close, high: t.close + 9, low: t.close, close: t.close + 8 });
    expect(JSON.stringify(pred)).toBe(before);
  });

  it("keeps a clean Jev snapshot for recent candles: no prices, no dates", () => {
    const p = new Predictor(900);
    let next = null;
    for (const c of candles(1000, 0.5)) next = p.close(c).next;
    const snap = p.snapshotFor(next!.forTime)!;
    expect(snap).toBeTruthy();
    const text = JSON.stringify(snap);
    expect(text).not.toMatch(/40\d\d\.\d/); // no raw gold prices
    expect(text).not.toMatch(/time/); //     no timestamps
    expect(text.length).toBeLessThan(4000);
  });

  it("the fact-check blocks a call it doesn't support, and lets a supported one through", () => {
    const p = new Predictor(900, 0.55);
    for (const c of candles(2000, 0.8)) p.close(c);
    const strongGreen = { pGreen: 0.8, support: 3 };
    const withSupport = p.applyJev(strongGreen)!;
    expect(withSupport.call).toBe(1);
    const noSupport = p.applyJev({ pGreen: 0.8, support: SUPPORT_NEEDED - 1 })!;
    expect(noSupport.call).toBe(0);
    expect(noSupport.blockedByCheck).toBe(true);
  });

  it("backfill scores Jev on past candles and teaches the blend to trust a good Jev", () => {
    const p = new Predictor(900);
    for (const c of candles(1500, 0.5)) p.close(c);
    const r = rng(3);
    const rows = Array.from({ length: 300 }, () => {
      const y = (r() < 0.5 ? 1 : 0) as 0 | 1;
      // A Jev that is right 65% of the time; a model with no information.
      const right = r() < 0.65;
      const pJ = (y === 1) === right ? 0.65 : 0.35;
      return { pModel: 0.5, jev: { pGreen: pJ, support: 2 }, y };
    });
    const before = p.summary().trust;
    const res = p.backfill(rows);
    console.log(`backfill: jev ${(res.jev.hitRate! * 100).toFixed(1)}% on ${res.jev.calls}, trust in Jev ${before?.jev ?? 0.5} → ${p.summary().trust!.jev.toFixed(2)}`);
    expect(res.jev.hitRate!).toBeGreaterThan(0.58);
    expect(p.summary().trust!.jev).toBeGreaterThan(0.5);
  });

  it("live % is calibrated (70% means ~70%) and gets sharper as the candle runs", () => {
    const r = rng(11);
    const p = new Predictor(900);
    let price = 4000;
    const bins = new Map<number, { n: number; g: number; sumP: number }>();
    let hitsHalf = 0;
    let nHalf = 0;
    for (let i = 0; i < 4000; i++) {
      const t0 = 1_700_000_100 - (1_700_000_100 % 900) + i * 900;
      const path = [price];
      for (let k = 0; k < 15; k++) path.push(path[path.length - 1] + (r() - 0.5) * 2);
      const close = path[15];
      for (const minute of [3, 7, 12]) {
        const seen = path.slice(0, minute + 1);
        const live = p.live({ time: t0, open: price, high: Math.max(...seen), low: Math.min(...seen), close: seen[minute] }, t0 + minute * 60);
        if (!live || close === price || i < 400) continue;
        const b = Math.round(live.pGreen * 10);
        const e = bins.get(b) ?? { n: 0, g: 0, sumP: 0 };
        e.n += 1;
        e.g += close > price ? 1 : 0;
        e.sumP += live.pGreen;
        bins.set(b, e);
        if (minute === 7 && live.call !== 0) {
          nHalf += 1;
          if ((live.call === 1) === close > price) hitsHalf += 1;
        }
      }
      p.close({ time: t0, open: price, high: Math.max(...path), low: Math.min(...path), close });
      price = close;
    }
    for (const [, e] of bins) if (e.n > 200) expect(Math.abs(e.sumP / e.n - e.g / e.n)).toBeLessThan(0.07);
    console.log(`live at the halfway point: ${nHalf} calls, ${((hitsHalf / nHalf) * 100).toFixed(1)}% right`);
    expect(hitsHalf / nHalf).toBeGreaterThan(0.7);
    expect(p.summary().halfway.n).toBeGreaterThan(1000);
  });
});
