import { describe, expect, it } from "vitest";
import { clock, lightspeedCore, normCdf, type LsCandle } from "./lightspeedCore";
import * as bot from "../../supabase/functions/_shared/lightspeedCore";

function candles(n: number, seed = 7): LsCandle[] {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const out: LsCandle[] = [];
  let p = 75000;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o * (1 + (rnd() - 0.5) * 0.004);
    out.push({ time: 1_760_000_000 + i * 300, open: o, high: Math.max(o, c) + rnd() * 30, low: Math.min(o, c) - rnd() * 30, close: c });
    p = c;
  }
  return out;
}

describe("lightspeed core", () => {
  it("normCdf matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normCdf(-1.96)).toBeCloseTo(0.024998, 5);
  });

  it("finish probability: 50% at the open, rises when price is above the open, sharper with less time", () => {
    const cs = candles(700);
    const t = cs[cs.length - 1].time + 300;
    const last = cs[cs.length - 1].close;
    const at = (move: number, el: number) =>
      (lightspeedCore(cs, t, 300, el, { time: t, open: last, high: last + Math.max(0, move), low: last + Math.min(0, move), close: last + move }) as {
        finish_probability: { random_walk_p_green_pct: number };
      }).finish_probability.random_walk_p_green_pct;
    expect(at(0, 30)).toBeCloseTo(50, 0);
    expect(at(40, 60)).toBeGreaterThan(55);
    expect(at(40, 270)).toBeGreaterThan(at(40, 60));
    expect(at(-40, 270)).toBeLessThan(45);
  });

  it("uses only candles closed before the call", () => {
    const cs = candles(700);
    const t = cs[600].time;
    expect(lightspeedCore(cs, t, 300, 0, null)).toEqual(lightspeedCore(cs.slice(0, 600), t, 300, 0, null));
  });

  it("clock knows US hours and funding times", () => {
    const c = clock(Date.UTC(2026, 10, 6, 14, 30) / 1000) as Record<string, unknown>; // 9:30 New York (EST)
    expect(c.us_stock_market_open).toBe(true);
    expect(c.minutes_to_next_funding_time).toBe(90);
  });

  it("the bot's copy gives exactly the same answers", () => {
    const cs = candles(800, 99);
    for (const k of [100, 400, 799]) {
      const t = cs[k].time;
      const f = { ...cs[k], close: cs[k].open + 12 };
      expect(bot.lightspeedCore(cs, t, 300, 90, f)).toEqual(lightspeedCore(cs, t, 300, 90, f));
    }
  });
});
