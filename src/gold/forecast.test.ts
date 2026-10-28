import { describe, expect, it } from "vitest";
import { buildScenarios, label, medoid, toCandles } from "./forecast";
import type { Candle } from "./indicators";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Random candles, except: after a big green candle, the next candle is always red. */
function history(n: number): Candle[] {
  const r = rng(5);
  const out: Candle[] = [];
  let p = 4000;
  for (let i = 0; i < n; i++) {
    const prev = out[out.length - 1];
    const forced = !!prev && prev.close - prev.open > 1.5;
    const big = r() < 0.15;
    const dir = forced ? -1 : r() < 0.5 ? 1 : -1;
    const body = (big ? 3 : 1) * (0.5 + r() * 0.5) * dir;
    const o = p;
    const c = o + body;
    out.push({ time: 1_700_000_100 - (1_700_000_100 % 900) + i * 900, open: o, close: c, high: Math.max(o, c) + r() * 0.5, low: Math.min(o, c) - r() * 0.5 });
    p = c;
  }
  return out;
}

describe("5-candle forecast scenarios", () => {
  it("builds 200 real paths and they fit in one Jev question", () => {
    const set = buildScenarios(history(3000), 200)!;
    expect(set.scenarios).toHaveLength(200);
    expect(set.scenarios.every((s) => s.candles.length === 5)).toBe(true);
    const text = set.scenarios.map(label).join("\n");
    expect(text.length).toBeLessThan(25_000); // ~6k tokens; Jev allows ~32k per call and 255 options
  });

  it("finds analogs that share the current setup", () => {
    const h = history(3000);
    // End history on a big green candle: the planted rule says the next one is red.
    const t = h[h.length - 1].time;
    const p = h[h.length - 1].close;
    h.push({ time: t + 900, open: p, close: p + 2.6, high: p + 2.8, low: p - 0.1 });
    const set = buildScenarios(h, 50)!;
    const firstRed = set.scenarios.filter((s) => s.candles[0].body < 0).length / set.scenarios.length;
    expect(firstRed).toBeGreaterThan(0.7);
  });

  it("draws a scenario as continuous candles from the current price", () => {
    const set = buildScenarios(history(800), 100)!;
    const cs = toCandles(medoid(set), 1_800_000_000, 4000, set.atr, 900);
    expect(cs).toHaveLength(5);
    expect(cs[0].open).toBe(4000);
    for (let k = 1; k < 5; k++) expect(cs[k].open).toBeCloseTo(cs[k - 1].close, 9);
    expect(cs.every((c) => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))).toBe(true);
  });
});
