// 5-candle forecast drawn as bars.
//
// Describe the market at the last close (shape of the last 3 candles, the recent move, where price sits in its
// recent range, time of day), find the 50 past moments that looked most like it, and take the 5 candles that
// actually came next after each. Every path is something gold really did, rescaled to today's volatility (ATR)
// and anchored at the last close. Jev picks the most likely one; without Jev, the most typical path is shown.
// Both are scored on what actually happens, so the page shows whether the bars are worth looking at.

import type { Candle } from "./indicators";

export const HORIZON = 5;
export const PATHS = 50;

export interface PathCandle {
  body: number; // signed close − open, ATR units
  up: number; //   upper wick, ATR units
  down: number; // lower wick, ATR units
}

export interface Path {
  id: string; // "s1".."s50", nearest first
  candles: PathCandle[];
}

export interface PathSet {
  paths: Path[];
  typical: Path; //         the path closest to all the others
  atr: number; //           ATR at the moment forecast, in dollars
  endsHigherPct: number; // share of paths that finish above the starting price
}

function wilderAtr(cs: Candle[], len = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let atr: number | null = null;
  const seed: number[] = [];
  cs.forEach((c, i) => {
    const pc = i ? cs[i - 1].close : null;
    const tr = pc === null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (atr === null) {
      seed.push(tr);
      if (seed.length === len) atr = seed.reduce((a, v) => a + v, 0) / len;
    } else atr = (tr + (len - 1) * atr) / len;
    out.push(atr);
  });
  return out;
}

const describe = (c: Candle, atr: number): PathCandle => ({
  body: (c.close - c.open) / atr,
  up: (c.high - Math.max(c.open, c.close)) / atr,
  down: (Math.min(c.open, c.close) - c.low) / atr,
});

/**
 * Every past moment, described once, so finding look-alikes is fast enough to also replay the forecast on
 * past candles. Rebuild it when new candles close.
 */
export class AnalogPool {
  private atrs: (number | null)[];
  private sigs: (number[] | null)[];
  // Running sums of each feature (and its square) up to each candle, so the scaling used for a moment only
  // reflects what was known by then.
  private sum: Float64Array[] = [];
  private sum2: Float64Array[] = [];
  private count: number[] = [];

  constructor(
    readonly history: Candle[], // closed candles, oldest first
    readonly tfSeconds: number,
  ) {
    this.atrs = wilderAtr(history);
    this.sigs = history.map((_, i) => this.signature(i));
    const dim = this.sigs.find((s) => s)?.length ?? 0;
    let s1 = new Float64Array(dim);
    let s2 = new Float64Array(dim);
    let n = 0;
    for (const sig of this.sigs) {
      if (sig) {
        s1 = s1.map((v, k) => v + sig[k]);
        s2 = s2.map((v, k) => v + sig[k] ** 2);
        n += 1;
      }
      this.sum.push(s1);
      this.sum2.push(s2);
      this.count.push(n);
    }
  }

  private scaleAt(at: number): number[] {
    const n = this.count[at];
    return Array.from(this.sum[at], (v, k) => {
      const m = v / n;
      return Math.sqrt(Math.max(0, this.sum2[at][k] / n - m * m)) || 1;
    });
  }

  /** What the market looked like right after candle i closed, scale-free. */
  private signature(i: number): number[] | null {
    const cs = this.history;
    const atr = this.atrs[i];
    if (i < 20 || !atr) return null;
    const f: number[] = [];
    for (let j = 0; j < 3; j++) {
      const c = cs[i - j];
      const rng = c.high - c.low;
      f.push((c.close - c.open) / atr, rng / atr, rng > 0 ? (c.close - c.low) / rng - 0.5 : 0);
    }
    f.push((cs[i].close - cs[i - 12].close) / (atr * Math.sqrt(12)));
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - 19; k <= i; k++) {
      hi = Math.max(hi, cs[k].high);
      lo = Math.min(lo, cs[k].low);
    }
    f.push(hi > lo ? (cs[i].close - lo) / (hi - lo) - 0.5 : 0);
    const d = new Date((cs[i].time + this.tfSeconds) * 1000);
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    f.push(0.5 * Math.sin((2 * Math.PI * h) / 24), 0.5 * Math.cos((2 * Math.PI * h) / 24));
    return f;
  }

  /**
   * Paths for the 5 candles after candle `at` (default: the last one). Only uses moments whose following
   * 5 candles had fully closed by then, so replays on past candles never peek ahead.
   */
  paths(at = this.history.length - 1, n = PATHS): PathSet | null {
    const now = this.sigs[at];
    const atrNow = this.atrs[at];
    if (!now || !atrNow) return null;
    const scale = this.scaleAt(at);
    const best: { i: number; d: number }[] = [];
    let worst = Infinity;
    for (let i = 20; i + HORIZON <= at; i++) {
      const s = this.sigs[i];
      if (!s) continue;
      let d = 0;
      for (let k = 0; k < s.length; k++) d += ((s[k] - now[k]) / scale[k]) ** 2;
      if (best.length < n) {
        best.push({ i, d });
        if (best.length === n) {
          best.sort((a, b) => a.d - b.d);
          worst = best[n - 1].d;
        }
      } else if (d < worst) {
        // insert in order, drop the worst
        let j = n - 1;
        while (j > 0 && best[j - 1].d > d) j--;
        best.splice(j, 0, { i, d });
        best.pop();
        worst = best[n - 1].d;
      }
    }
    if (best.length < Math.min(n, 20)) return null;
    best.sort((a, b) => a.d - b.d);
    const paths: Path[] = best.map((b, k) => ({
      id: `s${k + 1}`,
      // Each future candle in the ATR of its own time, so it rescales cleanly to now.
      candles: this.history.slice(b.i + 1, b.i + 1 + HORIZON).map((f) => describe(f, this.atrs[b.i]!)),
    }));
    const endsHigher = paths.filter((p) => p.candles.reduce((a, c) => a + c.body, 0) > 0).length;
    return { paths, typical: medoid(paths), atr: atrNow, endsHigherPct: endsHigher / paths.length };
  }
}

/** The path closest to all the others (by running price): the "most typical" outcome. */
export function medoid(paths: Path[]): Path {
  const run = (p: Path) => {
    let x = 0;
    return p.candles.map((c) => (x += c.body));
  };
  const rs = paths.map(run);
  let best = 0;
  let bestSum = Infinity;
  rs.forEach((a, i) => {
    const sum = rs.reduce((acc, b) => acc + Math.sqrt(a.reduce((x, v, k) => x + (v - b[k]) ** 2, 0)), 0);
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  });
  return paths[best];
}

const num = (v: number) => {
  const t = Math.abs(v).toFixed(2).replace(/^0(?=\.)/, "");
  return v < 0 ? `-${t}` : t;
};

/** Compact text for one path, e.g. "G+.62^.21v.10 R-.30^.05v.40 …" (body, upper wick, lower wick in ATR). */
export function label(p: Path): string {
  return p.candles.map((c) => `${c.body > 0 ? "G+" : c.body < 0 ? "R" : "D+"}${num(c.body)}^${num(c.up)}v${num(c.down)}`).join(" ");
}

/** Turn a path into real candles starting at `startTime`, opening at `startPrice`. */
export function toCandles(p: Path, startTime: number, startPrice: number, atr: number, tfSec: number): Candle[] {
  let open = startPrice;
  return p.candles.map((c, k) => {
    const close = open + c.body * atr;
    const candle = { time: startTime + k * tfSec, open, close, high: Math.max(open, close) + c.up * atr, low: Math.min(open, close) - c.down * atr };
    open = close;
    return candle;
  });
}

/** How a forecast path scored once its 5 candles closed. */
export interface PathScore {
  first: boolean | null; // first candle's color right (null if either was a doji)
  end: boolean | null; //   direction after 5 candles right
}

export function scorePath(p: Path, actual: Candle[], startPrice: number): PathScore {
  const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const f = sign(p.candles[0].body);
  const fa = sign(actual[0].close - actual[0].open);
  const e = sign(p.candles.reduce((a, c) => a + c.body, 0));
  const ea = sign(actual[actual.length - 1].close - startPrice);
  return { first: f && fa ? f === fa : null, end: e && ea ? e === ea : null };
}

/** Running tally of path scores. */
export class PathTally {
  first = { right: 0, n: 0 };
  end = { right: 0, n: 0 };
  add(s: PathScore) {
    if (s.first !== null) {
      this.first.n += 1;
      if (s.first) this.first.right += 1;
    }
    if (s.end !== null) {
      this.end.n += 1;
      if (s.end) this.end.right += 1;
    }
  }
  summary(): PathRecord {
    return { first: { ...this.first }, end: { ...this.end } };
  }
}

export interface PathRecord {
  first: { right: number; n: number };
  end: { right: number; n: number };
}
