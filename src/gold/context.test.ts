import { describe, expect, it } from "vitest";
import { lastBefore, marketContext } from "./context";
import type { Candle } from "./indicators";

const T0 = 1_761_955_200; // a UTC midnight
function walk(n: number, tf = 900): Candle[] {
  let p = 77_000;
  let s = 9;
  const r = () => ((s = (s * 1664525 + 1013904223) % 4294967296), s / 4294967296);
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p += (r() - 0.5) * 60;
    return { time: T0 + i * tf, open: o, close: p, high: Math.max(o, p) + r() * 10, low: Math.min(o, p) - r() * 10 };
  });
}

describe("market context for Jev", () => {
  it("has levels, volatility, longer timeframes and volume, with no prices or dates", () => {
    const cs = walk(400);
    const forTime = cs[300].time;
    const volume = new Map(cs.map((c, i) => [c.time, 100 + (i % 7) * 10]));
    const ctx = marketContext({ closed: cs, forTime, tfSeconds: 900, atr: 40, market: "btc", volume })!;
    expect(ctx.levels).toBeTruthy();
    expect((ctx.hourly_last_8 as unknown[]).length).toBe(8);
    expect((ctx.four_hour_last_6 as unknown[]).length).toBe(6);
    expect(ctx.volume).toBeTruthy();
    const text = JSON.stringify(ctx);
    expect(text).not.toMatch(/7\d{4}\./); // no BTC prices
    expect(text).not.toMatch(/17\d{8}/); // no timestamps
  });

  it("only uses candles from before the candle being asked about", () => {
    const cs = walk(400);
    const forTime = cs[300].time;
    const a = marketContext({ closed: cs, forTime, tfSeconds: 900, atr: 40, market: "btc" });
    const changed = cs.map((c, i) => (i >= 300 ? { ...c, close: c.close + 5000, high: c.high + 5000 } : c));
    const b = marketContext({ closed: changed, forTime, tfSeconds: 900, atr: 40, market: "btc" });
    expect(b).toEqual(a);
    expect(lastBefore(cs, forTime)).toBe(299);
  });
});
