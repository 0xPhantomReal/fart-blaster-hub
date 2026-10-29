// Next-candle forecast: combines three independent reads into one chance that the next candle closes green.
//
//   1. the learning model (its out-of-sample prediction at each close),
//   2. the candlestick + chart patterns active now, each worth what it has measured on gold's own history,
//   3. the analog paths: how often the candle after "moments like now" was green.
//
// The weights are fitted by logistic regression on an older stretch of history and then SCORED on a newer
// stretch the fit never saw, so the scoreboard says honestly whether the combination helps.

import type { Candle } from "./indicators";
import { AnalogIndex } from "./forecast";
import { buildFan } from "./fan";
import { measurePatterns, patternEdge, patternKeysAt, pivots, wilderAtr, type PatternBook } from "./patterns";

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => {
  const q = Math.min(0.999, Math.max(0.001, p));
  return Math.log(q / (1 - q));
};

export interface Reads {
  model: number | null; //  P(green) from the learning model (or model + Jev live)
  pattern: number; //       measured pattern edge, log-odds (0 = nothing)
  analog: number | null; // P(green) for the next candle among analog paths
}

/** Inputs to the combination, centred on the base rate so 0 means "no information". */
function features(r: Reads, base: number): number[] {
  const b = logit(base);
  return [r.model === null ? 0 : logit(r.model) - b, r.pattern, r.analog === null ? 0 : logit(r.analog) - b];
}

export class Combiner {
  constructor(
    readonly base: number,
    readonly w: number[] = [1, 1, 1],
    readonly bias = 0,
  ) {}

  predict(r: Reads): number {
    const x = features(r, this.base);
    return sigmoid(logit(this.base) + this.bias + x.reduce((a, v, k) => a + v * this.w[k], 0));
  }

  /** Logistic regression by gradient descent, with L2 pulling weights toward 0 (= ignore that read). */
  static fit(rows: { reads: Reads; y: 0 | 1 }[], base: number, l2 = 0.02, steps = 400): Combiner {
    const xs = rows.map((r) => features(r.reads, base));
    let w = [0, 0, 0];
    let b = 0;
    const lr = 0.5;
    const b0 = logit(base);
    for (let s = 0; s < steps; s++) {
      const gw = [0, 0, 0];
      let gb = 0;
      rows.forEach((r, i) => {
        const p = sigmoid(b0 + b + xs[i].reduce((a, v, k) => a + v * w[k], 0));
        const g = p - r.y;
        xs[i].forEach((v, k) => (gw[k] += g * v));
        gb += g;
      });
      w = w.map((wk, k) => wk - lr * (gw[k] / rows.length + l2 * wk));
      b -= lr * (gb / rows.length);
    }
    return new Combiner(base, w, b);
  }
}

// ── Scoring ───────────────────────────────────────────────────────────

export interface Score {
  n: number;
  hitRate: number | null; // on candles where the forecast leaned at least `edge` away from 50%
  calls: number;
  skill: number; //          Brier skill vs always forecasting the base rate (above 0 = useful)
}

export function score(ps: number[], ys: (0 | 1)[], base: number, edge = 0.04): Score {
  let brier = 0;
  let brierBase = 0;
  let calls = 0;
  let hits = 0;
  ps.forEach((p, i) => {
    brier += (p - ys[i]) ** 2;
    brierBase += (base - ys[i]) ** 2;
    if (Math.abs(p - 0.5) >= edge) {
      calls += 1;
      if ((p > 0.5 ? 1 : 0) === ys[i]) hits += 1;
    }
  });
  return { n: ps.length, calls, hitRate: calls ? hits / calls : null, skill: brierBase > 0 ? 1 - brier / brierBase : 0 };
}

export interface NextCandleReport {
  combiner: Combiner; //  fitted on all replayed candles, used live
  book: PatternBook; //   pattern measurements (from history before the replay)
  test: { model: Score; patterns: Score; analogs: Score; combined: Score };
  trainN: number;
}

/**
 * Replay the last `rows` candles that have a model prediction: fit the combination on the first 2/3,
 * score every read and the combination on the last 1/3.
 *
 * `history` is the full candle list (oldest first); `modelP[t]` is the model's P(green) for candle t+1
 * made at the close of candle t (null where it had none).
 */
export async function replayNextCandle(
  history: Candle[],
  modelP: (number | null)[],
  opts: { rows?: number; analogPaths?: number; yieldEvery?: number } = {},
): Promise<NextCandleReport | null> {
  const { rows = 2400, analogPaths = 300, yieldEvery = 50 } = opts;
  const last = history.length - 2;
  const ts: number[] = [];
  for (let t = last; t >= 0 && ts.length < rows; t--) if (modelP[t] !== null && modelP[t] !== undefined) ts.unshift(t);
  if (ts.length < 300) return null;

  // Patterns are measured only on history BEFORE the replay, so they can't have seen the answers.
  const book = measurePatterns(history, 0, ts[0]);
  const atrs = wilderAtr(history);
  const piv = pivots(history, atrs);
  const index = new AnalogIndex(history);

  const data: { reads: Reads; y: 0 | 1 }[] = [];
  let k = 0;
  for (const t of ts) {
    const nxt = history[t + 1];
    if (nxt.close === nxt.open || !atrs[t]) continue;
    const set = index.scenarios(t, analogPaths);
    data.push({
      reads: {
        model: modelP[t],
        pattern: patternEdge(book, patternKeysAt(history, t, atrs[t]!, piv)),
        analog: set ? buildFan(set).steps[0].pGreen : null,
      },
      y: nxt.close > nxt.open ? 1 : 0,
    });
    if (++k % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const cut = Math.floor((data.length * 2) / 3);
  const train = data.slice(0, cut);
  const test = data.slice(cut);
  const base = train.reduce((a, r) => a + r.y, 0) / train.length;
  const fitted = Combiner.fit(train, base);
  const ys = test.map((r) => r.y);
  const only = (f: (r: Reads) => number) => score(test.map((r) => f(r.reads)), ys, base);
  return {
    combiner: Combiner.fit(data, data.reduce((a, r) => a + r.y, 0) / data.length),
    book,
    trainN: train.length,
    test: {
      model: only((r) => r.model ?? base),
      patterns: only((r) => sigmoid(logit(base) + r.pattern)),
      analogs: only((r) => r.analog ?? base),
      combined: only((r) => fitted.predict(r)),
    },
  };
}
