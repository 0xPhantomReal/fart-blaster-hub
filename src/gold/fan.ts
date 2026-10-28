// Forecast range ("fan") for the next 5 candles, built from all the analog paths, and how to score it.
//
// For each of the 5 steps we take every path's cumulative close (in ATR units from the start price) and
// report weighted percentiles: the middle (50th), a 50% band (25th–75th) and an 80% band (10th–90th).
// A good fan is CALIBRATED: the 80% band contains the real price about 80% of the time, the 50% band about
// half the time, and the middle line lands closer to the real price than just assuming "no move".

import { AnalogIndex, HORIZON, type ScenarioSet } from "./forecast";

export interface FanStep {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number; //   cumulative move from the start, ATR units
  pGreen: number; // chance this step's candle closes green
}

export interface Fan {
  steps: FanStep[];
  endsHigher: number; // chance the price is above the start after 5 candles
}

function weightedQuantiles(values: number[], weights: number[], qs: number[]): number[] {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((a, w) => a + w, 0);
  const out: number[] = [];
  let acc = 0;
  let j = 0;
  for (const q of qs) {
    const target = q * total;
    while (j < idx.length - 1 && acc + weights[idx[j]] < target) acc += weights[idx[j++]];
    out.push(values[idx[j]]);
  }
  return out;
}

/** Fan from a set of paths. `weights` (same order as the paths) defaults to equal. */
export function buildFan(set: ScenarioSet, weights?: number[]): Fan {
  const w = weights ?? set.scenarios.map(() => 1);
  const total = w.reduce((a, x) => a + x, 0);
  const cum = set.scenarios.map((s) => {
    let c = 0;
    return s.candles.map((k) => (c += k.body));
  });
  const steps: FanStep[] = [];
  for (let k = 0; k < HORIZON; k++) {
    const vals = cum.map((p) => p[k]);
    const [p10, p25, p50, p75, p90] = weightedQuantiles(vals, w, [0.1, 0.25, 0.5, 0.75, 0.9]);
    const green = set.scenarios.reduce((a, s, i) => a + (s.candles[k].body > 0 ? w[i] : 0), 0) / total;
    steps.push({ p10, p25, p50, p75, p90, pGreen: green });
  }
  const endsHigher = cum.reduce((a, p, i) => a + (p[HORIZON - 1] > 0 ? w[i] : 0), 0) / total;
  return { steps, endsHigher };
}

/**
 * Turn Jev's ratings into path weights. `ratings` are Jev's probabilities within each batch of `batch`
 * paths; we compare each to an even share and mix half-and-half with equal weighting, so a single
 * confident answer tilts the fan without collapsing it.
 */
export function jevWeights(set: ScenarioSet, ratings: Record<string, number>, batch = 250): number[] {
  return set.scenarios.map((s, i) => {
    const batchSize = Math.min(batch, set.scenarios.length - Math.floor(i / batch) * batch);
    const r = ratings[s.id];
    const relative = r === undefined ? 1 : r * batchSize; // 1 = an even share
    return 0.5 + 0.5 * relative;
  });
}

// ── Scoring ───────────────────────────────────────────────────────────

export interface FanScore {
  windows: number; //    5-candle forecasts scored
  in50: number; //       share of steps where the real price was inside the 50% band (aim: 50%)
  in80: number; //       … inside the 80% band (aim: 80%)
  centerSkill: number; // 1 − (middle-line error ÷ "no move" error); above 0 beats assuming no move
  directionSkill: number; // Brier skill of "ends higher" vs a 50/50 guess; above 0 = useful
}

/** How much to stretch the bands so they hold what they promise (1 = no change). */
export interface BandCalibration {
  k50: number;
  k80: number;
}

/** Stretch a fan's bands around its middle line. */
export function calibrateFan(fan: Fan, c: BandCalibration): Fan {
  return {
    ...fan,
    steps: fan.steps.map((s) => ({
      ...s,
      p10: s.p50 - c.k80 * (s.p50 - s.p10),
      p90: s.p50 + c.k80 * (s.p90 - s.p50),
      p25: s.p50 - c.k50 * (s.p50 - s.p25),
      p75: s.p50 + c.k50 * (s.p75 - s.p50),
    })),
  };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export class FanTracker {
  // How far outside (> 1) or inside (< 1) each band the real price landed, relative to the band's half-width.
  private r50: number[] = [];
  private r80: number[] = [];
  private windows = 0;
  private steps = 0;
  private in50 = 0;
  private in80 = 0;
  private errCenter = 0;
  private errFlat = 0;
  private brier = 0;

  /** `actual[k]` = real cumulative move after step k, ATR units from the same start. */
  record(fan: Fan, actual: number[]): void {
    this.windows += 1;
    fan.steps.forEach((s, k) => {
      const a = actual[k];
      this.steps += 1;
      if (a >= s.p25 && a <= s.p75) this.in50 += 1;
      if (a >= s.p10 && a <= s.p90) this.in80 += 1;
      const ratio = (lo: number, hi: number) => {
        const half = a < s.p50 ? s.p50 - lo : hi - s.p50;
        return half > 1e-9 ? Math.abs(a - s.p50) / half : 0;
      };
      this.r50.push(ratio(s.p25, s.p75));
      this.r80.push(ratio(s.p10, s.p90));
      this.errCenter += Math.abs(a - s.p50);
      this.errFlat += Math.abs(a);
    });
    const up = actual[HORIZON - 1] > 0 ? 1 : 0;
    this.brier += (fan.endsHigher - up) ** 2;
  }

  /** Stretch factors that would have made the bands hold exactly 50% and 80% of what was scored. */
  calibration(): BandCalibration | null {
    if (this.r80.length < 100) return null;
    const clamp = (v: number) => Math.min(3, Math.max(0.5, v));
    return { k50: clamp(quantile(this.r50, 0.5)), k80: clamp(quantile(this.r80, 0.8)) };
  }

  summary(): FanScore | null {
    if (!this.windows) return null;
    return {
      windows: this.windows,
      in50: this.in50 / this.steps,
      in80: this.in80 / this.steps,
      centerSkill: this.errFlat > 0 ? 1 - this.errCenter / this.errFlat : 0,
      directionSkill: 1 - this.brier / this.windows / 0.25,
    };
  }
}

/**
 * Walk-forward replay: for past moments, build the fan using ONLY history before that moment, then
 * compare with what actually happened over the next 5 candles. Yields to the browser between chunks.
 */
export async function backtestFan(
  index: AnalogIndex,
  opts: { windows?: number; spacing?: number; paths?: number; yieldEvery?: number; when?: (t: number) => boolean } = {},
): Promise<{ score: FanScore | null; calibration: BandCalibration | null }> {
  const { windows = 200, spacing = 4, paths = 2000, yieldEvery = 10, when } = opts;
  const h = index.history;
  const tracker = new FanTracker();
  const last = h.length - 1 - HORIZON;
  let done = 0;
  for (let t = last - (windows - 1) * spacing; t <= last; t += spacing) {
    if (t < 200 || (when && !when(t))) continue;
    const set = index.scenarios(t, paths);
    const atr = index.atrs[t];
    if (!set || !atr) continue;
    const actual = Array.from({ length: HORIZON }, (_, k) => (h[t + 1 + k].close - h[t].close) / atr);
    tracker.record(buildFan(set), actual);
    if (++done % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return { score: tracker.summary(), calibration: tracker.calibration() };
}
