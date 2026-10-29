import { describe, expect, it } from "vitest";
import { AnalogPool, HORIZON, label, scorePath, toCandles } from "./forecast";
import type { Candle } from "./indicators";

function walk(n: number, seed = 3, tf = 900): Candle[] {
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) % 4294967296), s / 4294967296);
  const out: Candle[] = [];
  let p = 4000;
  for (let i = 0; i < n; i++) {
    const open = p;
    p += (r() - 0.5) * 4;
    out.push({ time: 1_700_000_000 - (1_700_000_000 % tf) + i * tf, open, close: p, high: Math.max(open, p) + r(), low: Math.min(open, p) - r() });
  }
  return out;
}

describe("bar forecast", () => {
  it("builds 50 five-candle paths from look-alike moments", () => {
    const pool = new AnalogPool(walk(3000), 900);
    const set = pool.paths()!;
    expect(set.paths).toHaveLength(50);
    expect(set.paths[0].candles).toHaveLength(HORIZON);
    expect(set.paths).toContain(set.typical);
    expect(label(set.paths[0]).split(" ")).toHaveLength(HORIZON);
  });

  it("never uses candles from after the moment it forecasts", () => {
    const h = walk(1000);
    const at = 600;
    const a = new AnalogPool(h, 900).paths(at)!;
    // Changing the future must not change the paths.
    const changed = h.map((c, i) => (i > at ? { ...c, close: c.close + 50, high: c.high + 50 } : c));
    const b = new AnalogPool(changed.slice(0, at + 1), 900).paths(at)!;
    expect(a.paths.map(label)).toEqual(b.paths.map(label));
  });

  it("draws a path as candles chained from the last close, and scores it", () => {
    const path = { id: "s1", candles: [{ body: 1, up: 0.2, down: 0.1 }, { body: -0.5, up: 0, down: 0 }, { body: 0.3, up: 0, down: 0 }, { body: 0.3, up: 0, down: 0 }, { body: 0.3, up: 0, down: 0 }] };
    const cs = toCandles(path, 100, 4000, 2, 60);
    expect(cs[0]).toMatchObject({ time: 100, open: 4000, close: 4002, high: 4002.4, low: 3999.8 });
    expect(cs[1].open).toBe(cs[0].close);
    expect(cs[4].time).toBe(100 + 4 * 60);
    const s = scorePath(path, cs, 4000);
    expect(s).toEqual({ first: true, end: true });
  });
});
