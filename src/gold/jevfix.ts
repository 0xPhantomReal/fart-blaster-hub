// "Jev refined": a small correction layer learned from Jev's own track record.
//
// Jev's answer can't be retrained, but its mistakes can be studied: for every candle Jev has called, this learns
// (walk-forward, wins and losses alike) when Jev's chance of green should be nudged — e.g. Jev too bullish
// overall, too confident, or wrong in a particular situation (after a streak, at a time of day, …).
//
// It starts as "trust Jev exactly" and is pulled back toward that, so with little evidence it changes nothing.
// It is refit on the recent window only, so it follows the market when the trend turns.

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

// Which inputs the correction uses (indexes into the predictor's signals + trend). Kept small on purpose: it is
// refit on only the last ~150 candles, and a handful of clear inputs can't memorize noise the way 19 can.
const PICK: { name: string; i: number }[] = [
  { name: "trend over last 20 candles", i: FEATURES.length + 0 },
  { name: "trend over last 50 candles", i: FEATURES.length + 1 },
  { name: "distance from 50-candle average", i: FEATURES.length + 2 },
  { name: "share of green candles", i: FEATURES.length + 3 },
  { name: "streak", i: FEATURES.indexOf("streak") },
  { name: "last candle's body", i: FEATURES.indexOf("last_candle_body") },
];
void INPUTS;

interface Sample {
  l: number; //      Jev's logit
  z: number[]; //    picked inputs
  y: 0 | 1;
}

/**
 * Refit on every closed candle from the recent window only, recent candles counting most (half-life ~40
 * candles), and pulled toward "trust Jev". So when the market turns and Jev's calls start losing the same
 * way, the correction follows within tens of candles instead of hundreds.
 */
export class JevFixer {
  private theta: number[]; // [a (Jev's logit), b (bias), ...weights for PICK]
  private prior: number[];
  private samples: Sample[] = [];
  updates = 0;

  constructor(
    private window = 150,
    private halfLife = 40,
    private pullJev = 1.5, //  strength of the pull toward trusting Jev's own number (pseudo-candles)
    private pullRest = 6, //   strength of the pull keeping situation weights at 0
  ) {
    this.prior = [1, 0, ...PICK.map(() => 0)];
    this.theta = [...this.prior];
  }

  private zOf(x: number[] | undefined) {
    return PICK.map((p) => (x && Number.isFinite(x[p.i]) ? clip(x[p.i], 3) : 0));
  }

  private score(l: number, z: number[]) {
    return this.theta[0] * l + this.theta[1] + z.reduce((s, v, k) => s + v * this.theta[2 + k], 0);
  }

  /** Jev's chance of green, corrected. */
  predict(pJev: number, x: number[] | undefined): number {
    return Math.min(0.99, Math.max(0.01, sigmoid(this.score(clip(logit(pJev)), this.zOf(x)))));
  }

  /** Learn from one candle Jev called, once it has closed: add it and refit on the recent window. */
  update(pJev: number, x: number[] | undefined, y: 0 | 1) {
    this.samples.push({ l: clip(logit(pJev)), z: this.zOf(x), y });
    if (this.samples.length > this.window) this.samples.shift();
    this.refit();
    this.updates += 1;
  }

  /** Weighted logistic regression with a pull toward the prior, by Newton's method. */
  private refit() {
    const d = this.theta.length;
    const n = this.samples.length;
    const lam = this.prior.map((_, k) => (k < 2 ? this.pullJev : this.pullRest));
    const decay = Math.pow(0.5, 1 / this.halfLife);
    let th = [...this.theta];
    for (let it = 0; it < 8; it++) {
      const g = th.map((t, k) => lam[k] * (t - this.prior[k]));
      const H = th.map((_, r) => th.map((__, c) => (r === c ? lam[r] : 0)));
      this.samples.forEach((s, i) => {
        const wgt = Math.pow(decay, n - 1 - i);
        const f = [s.l, 1, ...s.z];
        const p = sigmoid(f.reduce((acc, v, k) => acc + v * th[k], 0));
        const r = wgt * (p - s.y);
        const h = wgt * p * (1 - p);
        for (let a = 0; a < d; a++) {
          g[a] += r * f[a];
          for (let b = 0; b < d; b++) H[a][b] += h * f[a] * f[b];
        }
      });
      const step = solve(H, g);
      if (!step) break;
      th = th.map((t, k) => t - step[k]);
      if (Math.max(...step.map(Math.abs)) < 1e-6) break;
    }
    if (th.every(Number.isFinite)) this.theta = th.map((t, k) => (k === 0 ? Math.max(0, Math.min(3, t)) : clip(t, 5)));
  }

  summary(): FixSummary {
    const situations = PICK.map((p, k) => ({ name: p.name, weight: this.theta[2 + k] }))
      .filter((s) => Math.abs(s.weight) >= 0.1)
      .sort((p, q) => Math.abs(q.weight) - Math.abs(p.weight))
      .slice(0, 3);
    return { confidence: this.theta[0], bias: this.theta[1], situations };
  }
}

/** Solve H·x = g (small dense system, Gaussian elimination with pivoting). */
function solve(H: number[][], g: number[]): number[] | null {
  const n = g.length;
  const A = H.map((row, i) => [...row, g[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

/** Arrow scoring: above 50% = green call, below = red; dojis and exactly 50% don't count. */
export function scoreArrow(t: Tally, p: number, y: 0 | 1 | null) {
  if (y === null || p === 0.5) return;
  t.n += 1;
  if ((p > 0.5) === (y === 1)) t.right += 1;
}
