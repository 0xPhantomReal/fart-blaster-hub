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
    expect(snap.candles_1h_last_12).toHaveLength(12);
    expect(snap.candles_4h_last_6).toHaveLength(6);
    expect(JSON.stringify(snap).length).toBeLessThan(7500); // backend limit is 8000
  });
});
