// 5-candle forecast scenarios built from gold's own history ("analogs").
//
// We describe the market right now (shape of the last 3 candles, the recent move, where price sits in its
// recent range, time of day), find the N past moments that looked most similar, and take the candles that
// actually came next after each one. Every scenario is something gold really did, rescaled to today's
// volatility (ATR) and anchored at the current price. Jev then picks the most likely one.

import type { Candle } from "./indicators";

export const HORIZON = 5;

export interface ScenarioCandle {
  body: number; //   signed close − open, ATR units
  up: number; //     upper wick, ATR units
  down: number; //   lower wick, ATR units
}

export interface Scenario {
  id: string; //       "s1".."sN", nearest analog first
  candles: ScenarioCandle[];
  from: number; //     unix time of the historical moment it came from
  distance: number; // how unlike "now" that moment was (0 = identical)
}

export interface ScenarioSet {
  scenarios: Scenario[];
  atr: number; //           today's ATR in dollars, for drawing
  endsHigherPct: number; // share of scenarios that finish above the current price
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

/** What the market looked like right after candle i closed, scale-free. */
function signature(cs: Candle[], i: number, atr: number): number[] {
  const f: number[] = [];
  for (let j = 0; j < 3; j++) {
    const c = cs[i - j];
    const rng = c.high - c.low;
    f.push((c.close - c.open) / atr, rng / atr, rng > 0 ? (c.close - c.low) / rng - 0.5 : 0);
  }
  f.push((cs[i].close - cs[i - 12].close) / (atr * Math.sqrt(12)));
  const win = cs.slice(i - 19, i + 1);
  const hi = Math.max(...win.map((c) => c.high));
  const lo = Math.min(...win.map((c) => c.low));
  f.push(hi > lo ? (cs[i].close - lo) / (hi - lo) - 0.5 : 0);
  const d = new Date((cs[i].time + 900) * 1000);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  f.push(0.5 * Math.sin((2 * Math.PI * h) / 24), 0.5 * Math.cos((2 * Math.PI * h) / 24));
  return f;
}

const describe = (c: Candle, atr: number): ScenarioCandle => ({
  body: (c.close - c.open) / atr,
  up: (c.high - Math.max(c.open, c.close)) / atr,
  down: (Math.min(c.open, c.close) - c.low) / atr,
});

/** The candle that is forming right now, in ATR units from its open. `elapsed` is 0 at the open, 1 at the close. */
export interface FormingNow {
  move: number;
  high: number;
  low: number;
  elapsed: number;
}

/**
 * The `n` past moments most like now, and the 5 candles that followed each. History must be closed
 * candles, oldest first. With `forming`, paths whose first candle disagrees with what the current candle
 * has already done are pushed down the list, more strongly the further into the candle we are.
 */
export function buildScenarios(history: Candle[], n = 200, forming: FormingNow | null = null): ScenarioSet | null {
  const atrs = wilderAtr(history);
  const last = history.length - 1;
  const atrNow = atrs[last];
  if (!atrNow || last < 60) return null;
  const now = signature(history, last, atrNow);

  const cands: { i: number; sig: number[] }[] = [];
  for (let i = 20; i + HORIZON <= last; i++) {
    const a = atrs[i];
    if (a && a > 0) cands.push({ i, sig: signature(history, i, a) });
  }
  // Never use more than a third of history: beyond that the "analogs" stop resembling now.
  n = Math.min(n, Math.floor(cands.length / 3));
  if (n < 20) return null;

  // Standardize each feature so no single one dominates the distance.
  const dim = now.length;
  const mean = new Array(dim).fill(0);
  const sd = new Array(dim).fill(0);
  for (const c of cands) c.sig.forEach((v, k) => (mean[k] += v / cands.length));
  for (const c of cands) c.sig.forEach((v, k) => (sd[k] += (v - mean[k]) ** 2 / cands.length));
  const scale = sd.map((v) => Math.sqrt(v) || 1);
  const dist2 = (s: number[]) => s.reduce((a, v, k) => a + ((v - now[k]) / scale[k]) ** 2, 0);

  // How well each analog's first candle matches the candle forming now.
  let firstSd = 1;
  if (forming) {
    const bodies = cands.map((c) => (history[c.i + 1].close - history[c.i + 1].open) / atrs[c.i]!);
    const m = bodies.reduce((a, v) => a + v, 0) / bodies.length;
    firstSd = Math.sqrt(bodies.reduce((a, v) => a + (v - m) ** 2, 0) / bodies.length) || 1;
  }
  const formingPenalty = (i: number) => {
    if (!forming || forming.elapsed <= 0) return 0;
    const a = atrs[i]!;
    const f = history[i + 1];
    // Where the analog's first candle stood relative to its open (its final shape; we only have 15m data).
    const body = (f.close - f.open) / a;
    const hi = (f.high - f.open) / a;
    const lo = (f.low - f.open) / a;
    const miss = (body - forming.move) ** 2 + Math.max(0, forming.high - hi) ** 2 + Math.max(0, lo - forming.low) ** 2;
    return 3 * forming.elapsed * (miss / firstSd ** 2);
  };

  const nearest = cands
    .map((c) => ({ ...c, d: Math.sqrt(dist2(c.sig) + formingPenalty(c.i)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n);

  const scenarios: Scenario[] = nearest.map((c, k) => ({
    id: `s${k + 1}`,
    from: history[c.i].time,
    distance: c.d,
    // Express each future candle in the ATR of its own time, so it rescales cleanly to today.
    candles: history.slice(c.i + 1, c.i + 1 + HORIZON).map((f) => describe(f, atrs[c.i]!)),
  }));
  const endsHigher = scenarios.filter((s) => s.candles.reduce((a, c) => a + c.body, 0) > 0).length;
  return { scenarios, atr: atrNow, endsHigherPct: endsHigher / scenarios.length };
}

const num = (v: number) => {
  const t = Math.abs(v).toFixed(2).replace(/^0(?=\.)/, "");
  return v < 0 ? `-${t}` : t;
};

/** Compact text for one scenario, e.g. "G+.62^.21v.10 R-.30^.05v.40 …" (body, upper wick, lower wick in ATR). */
export function label(s: Scenario): string {
  return s.candles
    .map((c) => `${c.body > 0 ? "G+" : c.body < 0 ? "R" : "D+"}${num(c.body)}^${num(c.up)}v${num(c.down)}`)
    .join(" ");
}

/** The scenario closest to all the others: the "most typical" path, used when Jev isn't available. */
export function medoid(set: ScenarioSet): Scenario {
  const path = (s: Scenario) => {
    let p = 0;
    return s.candles.map((c) => (p += c.body));
  };
  const paths = set.scenarios.map(path);
  let best = 0;
  let bestSum = Infinity;
  paths.forEach((a, i) => {
    const sum = paths.reduce((acc, b) => acc + Math.sqrt(a.reduce((x, v, k) => x + (v - b[k]) ** 2, 0)), 0);
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  });
  return set.scenarios[best];
}

/** Turn a scenario into real candles starting at `startTime`, opening at `startPrice`. */
export function toCandles(s: Scenario, startTime: number, startPrice: number, atr: number, tfSec: number): Candle[] {
  let open = startPrice;
  return s.candles.map((c, k) => {
    const close = open + c.body * atr;
    const candle = {
      time: startTime + k * tfSec,
      open,
      close,
      high: Math.max(open, close) + c.up * atr,
      low: Math.min(open, close) - c.down * atr,
    };
    open = close;
    return candle;
  });
}
