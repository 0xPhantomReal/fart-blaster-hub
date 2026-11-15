/**
 * Stats mode (FADEBOT_TRADER_STATS=on): decide WITH Jev, AGAINST Jev or SKIP from how calls in the same conditions
 * did over the recent past.
 *
 * A call's conditions are three bands: Jev's % for his pick, the price of his side, and where BTC is against the
 * window's start price measured in the direction of his pick. Past calls in the same bands give how often Jev was
 * right; each choice is then priced at the CURRENT quote plus `slip` (the usual gap between quote and fill) and scored
 * on those past outcomes, after fees: with Jev (his side) and against him (the other side). The better of the two is
 * taken when it makes at least `minEdge` per $1; otherwise the call is skipped.
 * With too few past calls in the exact bands it widens step by step; with too few even then, it skips.
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

type Level = { name: string; match: (s: StatsSample) => boolean; needsDist: boolean };

export function statsDecide(call: StatsCall, samples: StatsSample[], cfg: StatsCfg): StatsDecision {
  const pb = pctBand(call.pct), cb = priceBand(call.jevCost), db = distBand(call.dist);
  const bands = [pb, `his side ${cb}`, db].filter(Boolean).join(" · ");
  const levels: Level[] = [
    { name: "% + price + BTC", needsDist: true, match: (s) => pctBand(s.pct) === pb && priceBand(s.jevCost) === cb && distBand(s.dist) === db },
    { name: "price + BTC", needsDist: true, match: (s) => priceBand(s.jevCost) === cb && distBand(s.dist) === db },
    { name: "% + price", needsDist: false, match: (s) => pctBand(s.pct) === pb && priceBand(s.jevCost) === cb },
    { name: "price", needsDist: false, match: (s) => priceBand(s.jevCost) === cb },
  ];
  for (const lv of levels) {
    if (lv.needsDist && db === null) continue;
    const m = samples.filter(lv.match);
    if (m.length < cfg.minN) continue;
    const right = m.filter((s) => s.pick === s.winner).length;
    // Today's prices, past outcomes.
    const withPer = m.reduce((a, s) => a + perDollar(call.jevCost + cfg.slip, s.pick === s.winner, cfg.fee), 0) / m.length;
    const againstPer = m.reduce((a, s) => a + perDollar(call.otherCost + cfg.slip, s.pick !== s.winner, cfg.fee), 0) /
      m.length;
    const best = withPer >= againstPer ? "with" : "against";
    const bestPer = Math.max(withPer, againstPer);
    const c = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}¢`;
    const tally = `${m.length} past calls (${lv.name}), Jev right ${right}/${m.length}; at today's ${
      Math.round(call.jevCost * 100)
    }¢/${Math.round(call.otherCost * 100)}¢ +${Math.round(cfg.slip * 100)}¢: with ${c(withPer)}/$1, against ${c(againstPer)}/$1`;
    const choice = bestPer >= cfg.minEdge ? best : "skip";
    return {
      choice,
      level: lv.name,
      n: m.length,
      jevRight: right / m.length,
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
