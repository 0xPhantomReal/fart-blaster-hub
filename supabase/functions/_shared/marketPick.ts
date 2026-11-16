/**
 * Market buys (FADEBOT_TRADER_ORDER=market): everything that happens to a call AFTER traderDecision said "buy",
 * in the live bot's order. The live bot and the replay (backtest) both run this, so they decide alike.
 *
 *   too early (FADEBOT_TRADER_MIN_SEC)                     → wait (ask again)
 *   stats mode on: statsPick (with / against / skip, invert, swap above, wrong-side skip)
 *   stats mode off:
 *     Jev % in a skip range (FADEBOT_TRADER_SKIP_JEV_PCT)  → wait
 *     live-price ban hit (hybrid; worked out by the caller) → wait
 *     side: Jev's, or the other side with FADEBOT_TRADER_INVERT=1
 *     price in a skip range (FADEBOT_TRADER_SKIP_RANGES)  → skip (ask again with SKIP_REASK=on, else window over)
 *     price in a swap range (FADEBOT_TRADER_SWAP_RANGES)  → buy the other side instead
 */
import { inRanges, type PriceRange, rangesText, type Side } from "./fadeStrategy.ts";
import { type PickCfg, type StatsCounts, type StatsDecision, statsPick } from "./statsMode.ts";

export type MarketCfg = {
  minSec: number;
  stats: boolean;
  statsCfg: PickCfg;
  invert: boolean;
  skipJevPct: PriceRange[];
  skipRanges: PriceRange[];
  swap: boolean;
  swapRanges: PriceRange[];
};

export type MarketCall = {
  /** traderDecision's buy: Jev's side, his chance for it, its price. */
  buy: Side;
  p: number;
  cost: number;
  /** Seconds into the window. */
  at: number;
  /** Both sides' prices now. */
  upCost: number | null;
  downCost: number | null;
  /** BTC vs the window's start price in the direction of Jev's pick ($), or null. */
  dist: number | null;
  /** The live-price ban message, when the caller checked one and it hit (hybrid only). */
  liveBanned?: string;
};

export type MarketPick =
  | { kind: "wait"; why: string; stats: StatsDecision | null }
  | { kind: "skip"; side: Side; cost: number; range: PriceRange; why: string }
  | {
    kind: "buy";
    side: Side;
    cost: number;
    /** Buying the side Jev did NOT pick (invert, stats against, or a swap). */
    otherSide: boolean;
    /** Stats mode chose AGAINST Jev (after its invert and swap). */
    statsAgainst: boolean;
    stats: StatsDecision | null;
    note: string;
  };

const opp = (s: Side): Side => (s === "up" ? "down" : "up");

export function marketPick(call: MarketCall, cfg: MarketCfg, counts: StatsCounts | null): MarketPick {
  if (call.at < cfg.minSec) {
    return { kind: "wait", why: `call at ${Math.floor(call.at)} s ignored: before ${cfg.minSec} s (FADEBOT_TRADER_MIN_SEC)`, stats: null };
  }
  const price = (s: Side) => (s === "up" ? call.upCost : call.downCost);
  if (cfg.stats) {
    if (!counts) return { kind: "wait", why: "stats: no history", stats: null };
    const other = price(opp(call.buy));
    const sp = statsPick(
      { pick: call.buy, pct: call.p, jevCost: call.cost, otherCost: other ?? 1 - call.cost, dist: call.dist },
      counts,
      cfg.statsCfg,
    );
    if (!sp.buy) {
      return {
        kind: "wait",
        why: `stats: Jev ${Math.round(call.p * 100)}% for ${call.buy} (${sp.decision.bands}): ${sp.note}`,
        stats: sp.decision,
      };
    }
    return {
      kind: "buy",
      side: sp.side,
      cost: sp.cost,
      otherSide: sp.side !== call.buy,
      statsAgainst: sp.against,
      stats: sp.decision,
      note: sp.note,
    };
  }
  const jp = inRanges(Math.round(call.p * 100) / 100, cfg.skipJevPct);
  if (jp) {
    return {
      kind: "wait",
      why: `Jev ${Math.round(call.p * 100)}% for ${call.buy}: in the ${Math.round(jp.lo * 100)}–${
        Math.round(jp.hi * 100)
      }% skip range (FADEBOT_TRADER_SKIP_JEV_PCT)`,
      stats: null,
    };
  }
  if (call.liveBanned) return { kind: "wait", why: call.liveBanned, stats: null };
  let side: Side = cfg.invert ? opp(call.buy) : call.buy;
  let cost = cfg.invert ? price(side) : call.cost;
  if (cost === null || !(cost > 0 && cost < 1)) return { kind: "wait", why: `no price for ${side}`, stats: null };
  const sk = inRanges(cost, cfg.skipRanges);
  if (sk) {
    return { kind: "skip", side, cost, range: sk, why: `${side} at ${Math.round(cost * 100)}¢ is in the ${rangesText([sk])} skip range` };
  }
  let note = "";
  const sw = cfg.swap ? inRanges(cost, cfg.swapRanges) : null;
  if (sw) {
    const oc = price(opp(side));
    if (oc !== null && oc > 0 && oc < 1) {
      note = ` (${side} at ${Math.round(cost * 100)}¢ is in the ${rangesText([sw])} swap range → swapped to ${opp(side)} at ${
        Math.round(oc * 100)
      }¢)`;
      side = opp(side);
      cost = oc;
    }
  }
  return { kind: "buy", side, cost, otherSide: side !== call.buy, statsAgainst: false, stats: null, note };
}
