import { describe, expect, it } from "vitest";
import { kellyStake, traderDecision } from "../../supabase/functions/_shared/fadeStrategy";

const CFG = { edge: 0.05, bankroll: 100, kelly: 0.25, maxBet: 10, minBet: 1, minLeftSec: 10, maxEntries: 3 };
const ctx = { secondsLeft: 200, entries: 0, lossLimitHit: false };

describe("Jev trader", () => {
  it("Kelly: quarter Kelly of $100, capped, zero without edge", () => {
    expect(kellyStake(0.65, 0.55, CFG)).toBeCloseTo(5.56, 2); // f = 0.10/0.45
    expect(kellyStake(0.95, 0.4, CFG)).toBe(10);
    expect(kellyStake(0.5, 0.55, CFG)).toBe(0);
    expect(kellyStake(0.57, 0.55, CFG)).toBe(1.11);
  });
  it("buys only with enough edge, sized by Kelly", () => {
    expect(traderDecision({ action: "buy_up", pUp: 0.7 }, { upCost: 0.6, downCost: 0.42 }, null, ctx, CFG)).toMatchObject({ buy: "up", cost: 0.6 });
    expect(traderDecision({ action: "buy_down", pUp: 0.7 }, { upCost: 0.6, downCost: 0.42 }, null, ctx, CFG)).toMatchObject({ none: expect.stringContaining("edge") });
    expect(traderDecision({ action: "buy_down", pUp: 0.3 }, { upCost: 0.6, downCost: 0.42 }, null, ctx, CFG)).toMatchObject({ buy: "down" });
  });
  it("respects the caps", () => {
    const j = { action: "buy_up" as const, pUp: 0.8 };
    const q = { upCost: 0.6, downCost: 0.42 };
    expect(traderDecision(j, q, null, { ...ctx, lossLimitHit: true }, CFG)).toHaveProperty("none");
    expect(traderDecision(j, q, null, { ...ctx, secondsLeft: 5 }, CFG)).toHaveProperty("none");
    expect(traderDecision(j, q, null, { ...ctx, entries: 3 }, CFG)).toHaveProperty("none");
  });
  it("holding: sells on sell, otherwise keeps", () => {
    expect(traderDecision({ action: "sell", pUp: 0.4 }, { upCost: 0.4, downCost: 0.62 }, { side: "up" }, ctx, CFG)).toEqual({ sell: true });
    expect(traderDecision({ action: "hold", pUp: 0.4 }, { upCost: 0.4, downCost: 0.62 }, { side: "up" }, ctx, CFG)).toHaveProperty("none");
  });
  it("bans buys from 45 to 60¢", () => {
    const BAN = { ...CFG, banLo: 0.45, banHi: 0.6 };
    expect(traderDecision({ action: "buy_up", pUp: 0.9 }, { upCost: 0.6, downCost: 0.42 }, null, ctx, BAN)).toMatchObject({ none: expect.stringContaining("45–60¢") });
    expect(traderDecision({ action: "buy_up", pUp: 0.9 }, { upCost: 0.45, downCost: 0.57 }, null, ctx, BAN)).toHaveProperty("none");
    expect(traderDecision({ action: "buy_up", pUp: 0.9 }, { upCost: 0.61, downCost: 0.41 }, null, ctx, BAN)).toMatchObject({ buy: "up" });
    expect(traderDecision({ action: "buy_down", pUp: 0.1 }, { upCost: 0.58, downCost: 0.44 }, null, ctx, BAN)).toMatchObject({ buy: "down" });
  });
});

import { trendSummary } from "../../supabase/functions/_shared/fadeStrategy";
describe("trend summary", () => {
  const stairs = (dir: number) =>
    Array.from({ length: 14 }, (_, i) => {
      const o = 100000 + dir * i * 30;
      return { open: o, close: o + dir * 25, high: Math.max(o, o + dir * 25) + 5, low: Math.min(o, o + dir * 25) - 5 };
    });
  it("calls a falling staircase below falling EMAs a strong downtrend", () => {
    const c = stairs(-1);
    const t = trendSummary(c, c[13].close, 99700, 99800, 40);
    expect(t.label).toBe("strong downtrend");
    expect(t.last_12_candle_colors).toBe("RRRRRRRRRRRR");
  });
  it("and the mirror image a strong uptrend; mixed candles no clear trend", () => {
    const c = stairs(1);
    expect(trendSummary(c, c[13].close, 100300, 100200, 40).label).toBe("strong uptrend");
    const mixed = Array.from({ length: 14 }, (_, i) => ({ open: 100000, close: 100000 + (i % 2 ? 20 : -20), high: 100030, low: 99970 }));
    expect(trendSummary(mixed, 100000, 100001, 100000, 40).label).toBe("no clear trend");
  });
});

describe("probability trigger", () => {
  const P = { ...CFG, edge: 0.2, trigger: "probability" as const };
  it("buys Jev's more-likely side at 20+ points even when Jev says wait", () => {
    expect(traderDecision({ action: "wait", pUp: 0.3 }, { upCost: 0.72, downCost: 0.48 }, null, ctx, P)).toMatchObject({ buy: "down", cost: 0.48 });
  });
  it("never buys the less-likely side (no 1¢ lottery tickets), nor under 20 points", () => {
    expect(traderDecision({ action: "wait", pUp: 0.21 }, { upCost: 0.01, downCost: null }, null, ctx, P)).toMatchObject({ none: "no price for down" });
    expect(traderDecision({ action: "buy_up", pUp: 0.65 }, { upCost: 0.5, downCost: 0.52 }, null, ctx, P)).toHaveProperty("none");
  });
});
