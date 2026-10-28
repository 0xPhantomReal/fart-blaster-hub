import { describe, expect, it } from "vitest";
import { Engine } from "./model";
import type { Candle } from "./indicators";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Candles where `fade` of big candles are followed by the opposite color. 0.5 = no pattern. */
function makeCandles(n: number, fade: number, seed = 7): Candle[] {
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
    out.push({ time: 1_700_000_000 + i * 300, open, high: Math.max(open, close) + spare * u, low: Math.min(open, close) - spare * (1 - u), close });
    price = close;
    prevBig = big ? dir : 0;
  }
  return out;
}

const run = (candles: Candle[]) => {
  const e = new Engine(300, 0.56, 300);
  for (const c of candles) e.close(c);
  return e.summary();
};

describe("gold engine", () => {
  it("finds a real planted pattern", () => {
    const s = run(makeCandles(4000, 0.8));
    expect(s.model.calls).toBeGreaterThan(100);
    expect(s.model.hitRate!).toBeGreaterThan(s.model.majority! + 0.05);
    expect(s.model.skill!).toBeGreaterThan(0.02);
  });

  it("shows no skill on random candles", () => {
    for (const seed of [1, 2, 3]) expect(run(makeCandles(4000, 0.5, seed)).model.skill!).toBeLessThan(0.02);
  });

  it("Jev's answer moves the blend in its direction", () => {
    const e = new Engine(300, 0.56, 300);
    for (const c of makeCandles(800, 0.5)) e.close(c);
    const before = e.close({ time: 1_800_000_000, open: 4000, high: 4001, low: 3999, close: 4000.5 }).next;
    expect(e.applyJev(0.9, 0.9)!.pFinal!).toBeGreaterThan(before.pFinal!);
    expect(e.applyJev(0.1, 0.9)!.pFinal!).toBeLessThan(before.pFinal!);
    expect(e.applyJev(0.5, 0.1)!.pFinal!).toBeCloseTo(before.pFinal!, 1);
  });

  it("gives Jev a compact multi-timeframe picture", () => {
    const e = new Engine(900, 0.56, 300);
    for (const c of makeCandles(600, 0.5).map((c, i) => ({ ...c, time: 1_700_000_000 + i * 900 }))) e.close(c);
    const snap = e.describeForJev()!;
    expect(snap.candles_15m_last_16).toHaveLength(16);
    expect(snap.candles_1h_last_6).toHaveLength(6);
    expect(snap.focus).toBeTruthy();
    expect(JSON.stringify(snap).length).toBeLessThan(7500); // backend limit is 8000
  });

  it("live probability at the halfway point beats a coin flip, even on patternless candles", () => {
    const r = rng(11);
    const e = new Engine(900, 0.56, 300);
    let price = 4000;
    let hits = 0;
    let calls = 0;
    for (let i = 0; i < 1500; i++) {
      // 15 one-minute random steps per candle
      const t0 = 1_700_000_000 + i * 900;
      const path = [price];
      for (let k = 0; k < 15; k++) path.push(path[path.length - 1] + (r() - 0.5) * 2);
      const half = path.slice(0, 8);
      const forming = { time: t0, open: price, high: Math.max(...half), low: Math.min(...half), close: half[half.length - 1] };
      const live = e.nowcast(forming, t0 + 7.5 * 60);
      const close = path[path.length - 1];
      if (live && e.warm && live.call !== 0 && close !== price) {
        calls += 1;
        if ((live.call === 1) === close > price) hits += 1;
      }
      e.close({ time: t0, open: price, high: Math.max(...path), low: Math.min(...path), close });
      price = close;
    }
    expect(calls).toBeGreaterThan(500);
    console.log(`halfway live call: ${calls} calls, ${((hits / calls) * 100).toFixed(1)}% right`);
    expect(hits / calls).toBeGreaterThan(0.7);
    expect(e.summary().halfway.n).toBeGreaterThan(500);
  });

  it("live Jev snapshot is small and only carries fresh data", () => {
    const e = new Engine(900, 0.56, 300);
    const cs = makeCandles(600, 0.5).map((c, i) => ({ ...c, time: 1_700_000_000 + i * 900 }));
    for (const c of cs) e.close(c);
    const t0 = cs[cs.length - 1].time + 900;
    const f = { time: t0, open: 4000, high: 4001.5, low: 3999.8, close: 4001.2 };
    const first = e.describeLive(f, t0 + 200, null)!;
    const next = e.describeLive(f, t0 + 210, { price: 4000.9, high: 4001.5, low: 3999.8 })!;
    expect(JSON.stringify(first).length).toBeLessThan(600); // vs ~4,300 for the full open snapshot
    expect(next.last_10_seconds).toMatchObject({ made_new_high: false, made_new_low: false });
    expect(next.context).toBe(first.context); // context built once per candle

    const before = e.nowcast(f, t0 + 200)!.pGreen;
    e.applyJevLive(f, 0.1);
    expect(e.nowcast(f, t0 + 200)!.pGreen).toBeLessThan(before);
  });
});
