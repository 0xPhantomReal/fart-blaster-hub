/**
 * Stats mode (FADEBOT_TRADER_STATS=on): decide WITH Jev, AGAINST Jev or SKIP from how calls in the same conditions
 * did over the recent past. The live bot and the replay (backtest) both use these functions, so they decide alike.
 *
 * A call's conditions are three bands: Jev's % for his pick, the price of his side, and where BTC is against the
 * window's start price measured in the direction of his pick. Past calls in the same bands give how often Jev was
 * right; each choice is then priced at the CURRENT quote plus `slip` (the usual gap between quote and fill) and scored
 * on those past outcomes, after fees: with Jev (his side) and against him (the other side). The better of the two is
 * taken when it makes at least `minEdge` per $1; otherwise the call is skipped. With too few past calls in the exact
 * bands it widens step by step; with too few even then, it skips.
 */

export type Side = "up" | "down";

/** One past call: Jev's pick, his %, the two quotes at the call, BTC vs start (his direction, $) and the winner. */
export type StatsSample = {
  window: number;
  pick: Side;
  pct: number;
  jevCost: number;
  otherCost: number;
  dist: number | null;
  winner: Side;
};

export type StatsCall = { pct: number; jevCost: number; otherCost: number; dist: number | null };

export type StatsCfg = { minN: number; slip: number; minEdge: number; fee: number };

export type StatsDecision = {
  choice: "with" | "against" | "skip";
  level: string;
  n: number;
  jevRight: number | null;
  withPer: number | null;
  againstPer: number | null;
  bands: string;
  why: string;
};

export function pctBand(p: number): string {
  const x = Math.round(p * 100);
  if (x <= 55) return "50–55%";
  if (x <= 60) return "56–60%";
  if (x <= 65) return "61–65%";
  if (x <= 70) return "66–70%";
  if (x <= 80) return "71–80%";
  return "81–100%";
}

export function priceBand(c: number): string {
  const x = Math.round(c * 100);
  if (x < 20) return "under 20¢";
  if (x < 30) return "20–29¢";
  if (x < 40) return "30–39¢";
  if (x < 50) return "40–49¢";
  if (x < 60) return "50–59¢";
  return "60¢+";
}

export function distBand(d: number | null): string | null {
  if (d === null || !Number.isFinite(d)) return null;
  if (d < -25) return "BTC $25+ against him";
  if (d < 0) return "BTC $0–25 against him";
  if (d <= 25) return "BTC $0–25 with him";
  return "BTC $25+ with him";
}

/** Profit per $1 on a binary share bought at `price` (fee: coefficient × p × (1 − p) per share). */
export function perDollar(price: number, won: boolean, fee: number): number {
  const p = Math.min(0.99, Math.max(0.01, price));
  const f = fee * (1 - p);
  return won ? 1 / p - 1 - f : -1 - f;
}

// ── History ──

/** One recorded ask, as the bot stores it. btc/ref are null on asks recorded before they were added. */
export type AskRow = {
  window: number;
  at: number;
  pUp: number;
  upCost: number;
  downCost: number;
  btc: number | null;
  ref: number | null;
  /** Jev's answer (buy_up / buy_down / wait …), when stored. */
  action?: string | null;
};

export type HistoryFilter = { edge: number; minSec: number; maxSec: number };

/** Does this ask count as a call (the edge cleared, inside the allowed seconds, no extreme price)? */
export function isCall(a: AskRow, f: HistoryFilter): boolean {
  const pick = a.pUp >= 0.5 ? "up" : "down";
  const jc = pick === "up" ? a.upCost : a.downCost;
  const oc = pick === "up" ? a.downCost : a.upCost;
  return a.at >= f.minSec && a.at <= f.maxSec && Math.max(a.pUp, 1 - a.pUp) - jc >= f.edge - 1e-9 &&
    jc > 0.02 && jc < 0.98 && oc > 0.02 && oc < 0.98;
}

/** The call's inputs to stats mode. BTC vs start uses the ask's own btc/ref, else the fallbacks given. */
export function callOf(
  a: AskRow,
  refFallback: (w: number) => number | null,
  btcFallback: (w: number, at: number) => number | null,
) {
  const pick: Side = a.pUp >= 0.5 ? "up" : "down";
  const jevCost = pick === "up" ? a.upCost : a.downCost;
  const otherCost = pick === "up" ? a.downCost : a.upCost;
  const ref = a.ref ?? refFallback(a.window);
  const btc = a.btc ?? btcFallback(a.window, a.at);
  const dist = ref !== null && btc !== null ? (pick === "up" ? 1 : -1) * (btc - ref) : null;
  return { pick, pct: Math.max(a.pUp, 1 - a.pUp), jevCost, otherCost, dist };
}

/**
 * Past calls as samples: ONE per window per bucket (Jev % band × price band × BTC band), the first such ask — a
 * window with dozens of similar asks has one result, so it counts once. `asks` must be in window, then second order.
 */
export function buildSamples(
  asks: AskRow[],
  f: HistoryFilter,
  winnerOf: (w: number) => Side | null,
  refFallback: (w: number) => number | null,
  btcFallback: (w: number, at: number) => number | null,
): StatsSample[] {
  const out: StatsSample[] = [];
  const seen = new Set<string>();
  for (const a of asks) {
    if (!isCall(a, f)) continue;
    const win = winnerOf(a.window);
    if (!win) continue;
    const c = callOf(a, refFallback, btcFallback);
    const k = `${a.window}|${pctBand(c.pct)}|${priceBand(c.jevCost)}|${distBand(c.dist) ?? "x"}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ window: a.window, ...c, winner: win });
  }
  return out;
}

/** Tallies of past calls per bucket, at every level stats mode can widen to. */
export type StatsCounts = Map<string, { n: number; right: number }>;

function keysOf(s: { pct: number; jevCost: number; dist: number | null }): string[] {
  const pb = pctBand(s.pct), cb = priceBand(s.jevCost), db = distBand(s.dist);
  const k = [`ab|${pb}|${cb}`, `b|${cb}`];
  if (db !== null) k.push(`abc|${pb}|${cb}|${db}`, `bc|${cb}|${db}`);
  return k;
}

export function addSample(counts: StatsCounts, s: StatsSample, sign: 1 | -1 = 1) {
  const r = s.pick === s.winner ? 1 : 0;
  for (const k of keysOf(s)) {
    const x = counts.get(k) ?? { n: 0, right: 0 };
    x.n += sign;
    x.right += sign * r;
    counts.set(k, x);
  }
}

export function countSamples(samples: StatsSample[]): StatsCounts {
  const c: StatsCounts = new Map();
  for (const s of samples) addSample(c, s);
  return c;
}

// ── Decision ──

export function statsDecide(call: StatsCall, counts: StatsCounts, cfg: StatsCfg): StatsDecision {
  const pb = pctBand(call.pct), cb = priceBand(call.jevCost), db = distBand(call.dist);
  const bands = [pb, `his side ${cb}`, db].filter(Boolean).join(" · ");
  const levels: { name: string; key: string | null }[] = [
    { name: "% + price + BTC", key: db === null ? null : `abc|${pb}|${cb}|${db}` },
    { name: "price + BTC", key: db === null ? null : `bc|${cb}|${db}` },
    { name: "% + price", key: `ab|${pb}|${cb}` },
    { name: "price", key: `b|${cb}` },
  ];
  const c = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}¢`;
  for (const lv of levels) {
    if (!lv.key) continue;
    const t = counts.get(lv.key);
    if (!t || t.n < cfg.minN) continue;
    const rr = t.right / t.n;
    // Today's prices, past outcomes.
    const withPer = rr * perDollar(call.jevCost + cfg.slip, true, cfg.fee) +
      (1 - rr) * perDollar(call.jevCost + cfg.slip, false, cfg.fee);
    const againstPer = (1 - rr) * perDollar(call.otherCost + cfg.slip, true, cfg.fee) +
      rr * perDollar(call.otherCost + cfg.slip, false, cfg.fee);
    const best = withPer >= againstPer ? "with" : "against";
    const choice = Math.max(withPer, againstPer) >= cfg.minEdge ? best : "skip";
    const tally = `${t.n} past calls (${lv.name}), Jev right ${t.right}/${t.n}; at today's ${
      Math.round(call.jevCost * 100)
    }¢/${Math.round(call.otherCost * 100)}¢ +${Math.round(cfg.slip * 100)}¢: with ${c(withPer)}/$1, against ${c(againstPer)}/$1`;
    return {
      choice,
      level: lv.name,
      n: t.n,
      jevRight: rr,
      withPer,
      againstPer,
      bands,
      why: `${tally} → ${choice === "skip" ? `SKIP (neither beat ${c(cfg.minEdge)})` : choice.toUpperCase()}`,
    };
  }
  return {
    choice: "skip",
    level: "none",
    n: 0,
    jevRight: null,
    withPer: null,
    againstPer: null,
    bands,
    why: `fewer than ${cfg.minN} past calls even with wider bands → SKIP`,
  };
}

/** Stats mode's extra rules on top of the decision (all optional). */
export type PickCfg = StatsCfg & { invert: boolean; swapAbove: number; maxAgainst: number };

export type StatsPick =
  | { buy: false; decision: StatsDecision; note: string }
  | { buy: true; decision: StatsDecision; side: Side; cost: number; against: boolean; note: string };

/**
 * The whole stats-mode pick for one call, in the live bot's order: decide (with / against / skip) → stats invert →
 * swap a side over `swapAbove` to the cheaper side → skip if BTC is more than `maxAgainst` past the start line
 * against the side actually being bought.
 */
export function statsPick(call: StatsCall & { pick: Side }, counts: StatsCounts, cfg: PickCfg): StatsPick {
  const decision = statsDecide(call, counts, cfg);
  if (decision.choice === "skip") return { buy: false, decision, note: decision.why };
  const other: Side = call.pick === "up" ? "down" : "up";
  let against = (decision.choice === "against") !== cfg.invert;
  let side: Side = against ? other : call.pick;
  let cost = against ? call.otherCost : call.jevCost;
  let note = "";
  if (cfg.invert) note += ` (inverted from ${decision.choice.toUpperCase()})`;
  if (cfg.swapAbove > 0 && cost > cfg.swapAbove + 1e-9) {
    const oc = against ? call.jevCost : call.otherCost;
    note += ` (${side} at ${Math.round(cost * 100)}¢ is over ${Math.round(cfg.swapAbove * 100)}¢ → swapped to ${
      side === "up" ? "down" : "up"
    } at ${Math.round(oc * 100)}¢)`;
    against = !against;
    side = against ? other : call.pick;
    cost = oc;
  }
  if (cfg.maxAgainst > 0 && call.dist !== null) {
    const sideDist = side === call.pick ? call.dist : -call.dist;
    if (sideDist < -cfg.maxAgainst) {
      return {
        buy: false,
        decision,
        note: `stats would buy ${side}${note}, but BTC is $${Math.abs(sideDist).toFixed(0)} on the wrong side of the start (more than $${cfg.maxAgainst})`,
      };
    }
  }
  return { buy: true, decision, side, cost, against, note };
}
