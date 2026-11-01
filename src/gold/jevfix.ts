// "Jev refined": a small correction layer learned from Jev's own track record.
//
// Jev's answer can't be retrained, but its mistakes can be studied: for every candle Jev has called, this learns
// (walk-forward, wins and losses alike) when Jev's chance of green should be nudged — e.g. Jev too bullish
// overall, too confident, or wrong in a particular situation (after a streak, at a time of day, …).
//
// It starts as "trust Jev exactly" and every weight is pulled back toward that, so with little evidence it
// changes nothing; it only moves Jev's number when Jev's record keeps showing the same kind of miss.

import { FEATURES, TREND_FEATURES } from "./predictor";

const INPUTS = [...FEATURES, ...TREND_FEATURES];

const clip = (x: number, a = 4) => Math.max(-a, Math.min(a, x));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return Math.log(q / (1 - q));
};

export interface Tally {
  right: number;
  n: number;
}

/** What the correction has learned, in words the page can show. */
export interface FixSummary {
  confidence: number; //  1 = Jev's confidence kept; <1 = Jev was overconfident; >1 = underconfident
  bias: number; //        >0 = Jev was too bearish (nudged toward green); <0 = too bullish
  situations: { name: string; weight: number }[]; // strongest situation-specific corrections
}

export class JevFixer {
  private a = 1; //                      weight on Jev's logit (starts: trust Jev as is)
  private b = 0; //                      bias
  private w = new Array(INPUTS.length).fill(0);
  updates = 0;

  constructor(
    private lr = 0.02,
    private pull = 0.003, // how hard every weight is pulled back toward "trust Jev"
  ) {}

  // Inputs are already scale-free (ATR units, shares, ±1 time-of-day), so they are used as levels rather than
  // re-centered: a long uptrend must still read as "up", not as "the new normal".
  private z(x: number[] | undefined) {
    if (!x) return this.w.map(() => 0);
    return x.map((v) => clip(v, 3));
  }

  /** Jev's chance of green, corrected. */
  predict(pJev: number, x: number[] | undefined): number {
    const z = this.z(x);
    const v = this.a * clip(logit(pJev)) + this.b + z.reduce((s, zi, i) => s + zi * this.w[i], 0);
    return Math.min(0.99, Math.max(0.01, sigmoid(v)));
  }

  /** Learn from one candle Jev called, once it has closed. */
  update(pJev: number, x: number[] | undefined, y: 0 | 1) {
    const z = this.z(x);
    const l = clip(logit(pJev));
    const g = this.predict(pJev, x) - y;
    this.a -= this.lr * (g * l + this.pull * (this.a - 1));
    this.b -= this.lr * (g + this.pull * this.b);
    for (let i = 0; i < this.w.length; i++) this.w[i] -= this.lr * (g * z[i] + this.pull * this.w[i]);
    this.updates += 1;
  }

  summary(): FixSummary {
    const situations = this.w
      .map((weight, i) => ({ name: INPUTS[i].replace(/_/g, " "), weight }))
      .filter((s) => Math.abs(s.weight) >= 0.05)
      .sort((p, q) => Math.abs(q.weight) - Math.abs(p.weight))
      .slice(0, 3);
    return { confidence: this.a, bias: this.b, situations };
  }
}

/** Arrow scoring: above 50% = green call, below = red; dojis and exactly 50% don't count. */
export function scoreArrow(t: Tally, p: number, y: 0 | 1 | null) {
  if (y === null || p === 0.5) return;
  t.n += 1;
  if ((p > 0.5) === (y === 1)) t.right += 1;
}
