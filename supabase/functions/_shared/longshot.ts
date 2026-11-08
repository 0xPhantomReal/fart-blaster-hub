// Longshot (FADEBOT_STRATEGY = longshot): buy only sides that are all but decided, late in the window, at 85–99¢.
//
// Polymarket's 5-minute BTC markets settle Up when the BRTI average over the window's LAST 60 seconds is at or above
// the BRTI average over the 60 seconds before the window started. Late in the window part of that closing average is
// already fixed, so the outcome can be worked out much more exactly than from the price alone:
//
//   final average = w · (average of the closing-minute prices so far) + (1 − w) · (average of the prices still to come)
//   w = seconds of the closing minute already passed / 60
//
// The prices still to come start at today's price and wander; the average of a random walk over T seconds has variance
// σ²·T/3, plus σ² per second of any gap before the closing minute starts. A safety factor widens σ (fat tails, jumps)
// and a fixed "feed error" covers small differences between our BRTI feed and the official one.

export function normCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26 via erf; error < 1.5e-7.
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export interface SettleInput {
  startRef: number; //     BRTI average over the minute before the window
  now: number; //          seconds (unix)
  end: number; //          window end (unix)
  price: number; //        BRTI now
  knownAvg: number | null; // average of BRTI over the closing minute so far (null before it starts)
  knownSec: number; //     seconds of the closing minute already passed (0–60)
  sigmaPerSec: number; //  BRTI volatility, dollars per √second
  safety: number; //       multiplies σ (≥ 1)
  feedSd: number; //       dollars of feed/rounding error
}

/** Chance the window settles Up, and the pieces behind it. */
export function settleProbability(x: SettleInput) {
  const known = Math.max(0, Math.min(60, x.knownSec));
  const w = known / 60;
  const remaining = 60 - known;
  const gap = Math.max(0, x.end - 60 - x.now);
  const sig = x.sigmaPerSec * x.safety;
  const variance = (1 - w) ** 2 * sig * sig * (gap + remaining / 3) + x.feedSd ** 2;
  const mean = w * (x.knownAvg ?? x.price) + (1 - w) * x.price;
  const sd = Math.sqrt(variance);
  const margin = mean - x.startRef;
  const pUp = sd > 0 ? normCdf(margin / sd) : margin >= 0 ? 1 : 0;
  return { pUp, expectedFinal: mean, sd, margin, w };
}

export interface LongshotCfg {
  minCost: number; //     0.85
  maxCost: number; //     0.99
  minProb: number; //     0.995: our chance for the side must be at least this
  margin: number; //      0.01: and beat the cost by this much
  feePerShare: number; // estimated fee per share (dollars) for the profit check
  windowSec: number; //   only in the last N seconds (90)
  stopSec: number; //     … and not in the last M seconds (3)
}

/** Whether to buy a side now. */
export function longshotDecision(
  p: { pUp: number },
  q: { upCost: number | null; downCost: number | null },
  secondsLeft: number,
  cfg: LongshotCfg,
): { side: "up" | "down"; p: number; cost: number } | { none: string; side?: "up" | "down"; p?: number; cost?: number | null } {
  if (secondsLeft > cfg.windowSec) return { none: `waiting for the last ${cfg.windowSec} s` };
  if (secondsLeft < cfg.stopSec) return { none: "too close to the end" };
  const side = p.pUp >= 0.5 ? "up" : "down";
  const ps = side === "up" ? p.pUp : 1 - p.pUp;
  const cost = side === "up" ? q.upCost : q.downCost;
  const base = { side, p: ps, cost } as const;
  if (ps < cfg.minProb) return { ...base, none: `${side} ${(ps * 100).toFixed(2)}% < ${(cfg.minProb * 100).toFixed(1)}%` };
  if (cost === null) return { ...base, none: `no price for ${side}` };
  if (cost < cfg.minCost - 1e-9 || cost > cfg.maxCost + 1e-9) {
    return { ...base, none: `${side} costs ${Math.round(cost * 100)}¢, outside ${Math.round(cfg.minCost * 100)}–${Math.round(cfg.maxCost * 100)}¢` };
  }
  if (ps - cost < cfg.margin - 1e-9) {
    return { ...base, none: `${(ps * 100).toFixed(2)}% vs ${Math.round(cost * 100)}¢: under ${Math.round(cfg.margin * 100)} point margin` };
  }
  if (1 - cost - cfg.feePerShare <= 0) return { ...base, none: "no profit after fees" };
  return { side, p: ps, cost };
}

/**
 * How many dollars can be bought at or below `maxCost` for `side`, from the YES book (offers to buy YES, bids to buy
 * NO at 1 − bid). `yesIsUp` says which side YES pays on.
 */
export function depthDollars(
  book: { bids: [number, number][]; offers: [number, number][] },
  side: "up" | "down",
  yesIsUp: boolean,
  maxCost: number,
): number {
  const buyYes = (side === "up") === yesIsUp;
  const levels = buyYes
    ? book.offers.map(([px, q]) => [px, q] as [number, number])
    : book.bids.map(([px, q]) => [1 - px, q] as [number, number]);
  return levels.filter(([c]) => c <= maxCost + 1e-9).reduce((s, [c, q]) => s + c * q, 0);
}
