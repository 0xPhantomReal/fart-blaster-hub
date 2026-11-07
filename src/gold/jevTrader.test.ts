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
});
