import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { candleStrength } from "./candleStrength";
import { lightspeedDecision } from "../../supabase/functions/_shared/fadeStrategy";

const core = (move: number, typical = 50, perCandlePct = 0.08) => ({
  finish_probability: { move_dollars: move, typical_move_in_time_left_dollars: typical },
  volatility: { per_candle_pct: perCandlePct },
});
const live = {
  coinbase_trade_flow_now: { last_30s: { buy_share_pct: 80, trades: 40 } },
  coinbase_order_book: { imbalance_within_25bps: 0.4 },
  kraken_order_book: { imbalance_within_25bps: 0.2 },
  other_coins: { eth: { move_since_candle_open_pct: 0.15 }, sol: { move_since_candle_open_pct: 0.05 } },
};
const RULE = { fadeWindowSec: 120, strongFromSec: 60, strongToSec: 240, strongMin: 60 };

describe("candle strength", () => {
  it("is strongly up for a big up move closing at the high with buyers, book and other coins agreeing", () => {
    const s = candleStrength(core(80), live, 90, 300, { open: 100000, high: 100080, low: 99995, close: 100080 })!;
    expect(s.direction).toBe("up");
    expect(s.strength).toBeGreaterThan(70);
    expect(s.used).toBe("momentum, close, flow, book, others");
  });
  it("is weak when the move is fading from its high and flow is against it", () => {
    const s = candleStrength(core(30), { ...live, coinbase_trade_flow_now: { last_30s: { buy_share_pct: 20, trades: 40 } } }, 90, 300, {
      open: 100000, high: 100090, low: 99990, close: 100030,
    })!;
    expect(s.strength).toBeLessThan(40);
  });
  it("works on candle data alone", () => {
    const s = candleStrength(core(-60), null, 60, 300, { open: 100000, high: 100005, low: 99940, close: 99940 })!;
    expect(s.direction).toBe("down");
    expect(s.used).toBe("momentum, close");
  });
  it("the bot's copy is identical", () => {
    const a = readFileSync("src/gold/candleStrength.ts", "utf8");
    const b = readFileSync("supabase/functions/_shared/candleStrength.ts", "utf8").split("\n").slice(1).join("\n");
    expect(b).toBe(a);
  });
});

describe("Lightspeed rule with strength", () => {
  const st = (score: number) => ({ score, strength: Math.abs(score), direction: score > 0 ? "up" : "down" });
  it("big + weak in the first 2 minutes → fade", () => {
    expect(lightspeedDecision(core(60), st(30), 40, RULE)).toMatchObject({ side: "down", kind: "ls-fade" });
  });
  it("big + strong before minute 1 → wait; after → bet with it", () => {
    expect(lightspeedDecision(core(60), st(75), 40, RULE)).toMatchObject({ wait: true });
    expect(lightspeedDecision(core(60), st(75), 70, RULE)).toMatchObject({ side: "up", kind: "ls-strong" });
  });
  it("strong without a big move, minutes 1–3 → bet with it; outside → nothing", () => {
    expect(lightspeedDecision(core(-20), st(-65), 200, RULE)).toMatchObject({ side: "down", kind: "ls-strong" });
    expect("skip" in lightspeedDecision(core(-20), st(-65), 30, RULE)).toBe(true);
    expect("skip" in lightspeedDecision(core(-20), st(-65), 240, RULE)).toBe(true);
  });
  it("strength against the move never counts; big move after 2 minutes isn't faded", () => {
    expect(lightspeedDecision(core(60), st(-80), 50, RULE)).toMatchObject({ kind: "ls-fade" });
    expect("skip" in lightspeedDecision(core(60), st(30), 150, RULE)).toBe(true);
  });
});
