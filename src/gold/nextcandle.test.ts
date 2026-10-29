import { describe, expect, it } from "vitest";
import { Combiner, replayNextCandle } from "./nextcandle";
import { candlePatterns, wilderAtr } from "./patterns";
import type { Candle } from "./indicators";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const T0 = 1_700_000_100 - (1_700_000_100 % 900);

/** Random candles; after a bullish engulfing the next is green `boost` of the time. */
function history(n: number, boost: number, seed = 4): Candle[] {
  const r = rng(seed);
  const out: Candle[] = [];
  let p = 4000;
  for (let i = 0; i < n; i++) {
    let dir = r() < 0.5 ? 1 : -1;
    if (out.length > 30 && boost > 0.5) {
      const atr = wilderAtr(out.slice(-40)).at(-1)!;
      if (candlePatterns(out, out.length - 1, atr).some((x) => x.name === "Bullish engulfing")) dir = r() < boost ? 1 : -1;
    }
    const b = (0.2 + r() * 1.2) * dir;
    const o = p;
    const c = o + b;
    out.push({ time: T0 + i * 900, open: o, close: c, high: Math.max(o, c) + r() * 0.4, low: Math.min(o, c) - r() * 0.4 });
    p = c;
  }
  return out;
}

describe("next-candle forecaster", () => {
  it("learns to ignore a useless read and to trust a useful one", () => {
    const r = rng(1);
    const rows = Array.from({ length: 4000 }, () => {
      const y = (r() < 0.5 ? 1 : 0) as 0 | 1;
      // model: pure noise; patterns: informative
      const informative = r() < 0.3;
      return { reads: { model: 0.3 + r() * 0.4, pattern: informative ? (y ? 0.8 : -0.8) : 0, analog: null }, y };
    });
    const c = Combiner.fit(rows, 0.5);
    expect(Math.abs(c.w[0])).toBeLessThan(0.15);
    expect(c.w[1]).toBeGreaterThan(0.5);
  });

  it("on history with a real pattern, the combination scores above zero on unseen candles", async () => {
    const h = history(9000, 0.85);
    const modelP = h.map((_, t) => (t > 300 ? 0.5 : null)); // a model with no opinion
    const rep = (await replayNextCandle(h, modelP, { rows: 3000, analogPaths: 150, yieldEvery: 1e9 }))!;
    const fmt = (s: { skill: number; hitRate: number | null; calls: number }) =>
      `skill ${s.skill.toFixed(3)}, hit ${s.hitRate === null ? "—" : (s.hitRate * 100).toFixed(1) + "%"} on ${s.calls}`;
    console.log(`patterns: ${fmt(rep.test.patterns)} | analogs: ${fmt(rep.test.analogs)} | combined: ${fmt(rep.test.combined)}`);
    expect(rep.test.patterns.skill).toBeGreaterThan(0);
    expect(rep.test.combined.skill).toBeGreaterThan(0);
  });

  it("on pure noise, nothing claims skill", async () => {
    const h = history(6000, 0.5, 8);
    const modelP = h.map((_, t) => (t > 300 ? 0.5 : null));
    const rep = (await replayNextCandle(h, modelP, { rows: 2400, analogPaths: 150, yieldEvery: 1e9 }))!;
    console.log(`noise: combined skill ${rep.test.combined.skill.toFixed(3)}, patterns ${rep.test.patterns.skill.toFixed(3)}`);
    expect(rep.test.combined.skill).toBeLessThan(0.01);
  });
});
