// Will the candle that's forming right now flip color before it closes?
//
//   math — the move so far against how far gold typically travels in the time left (random-walk scaling of
//          recent candle bodies), starting from the open forecast
//   Jev  — reads a small snapshot of the candle so far and answers "holds or flips?" (it never sees the math)
//   blend — math and Jev weighted by their records: first from a replay on recent past candles rebuilt from
//          1-minute data, then from live results
//
// Everything is scored on the final color of the candle.

import type { Candle } from "./indicators";
import { normCdf, Stacker, Tracker, type TrackRecord } from "./predictor";

const r2 = (v: number) => Number(v.toFixed(2));
const logit = (p: number) => {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return Math.log(q / (1 - q));
};
const clamp = (p: number) => Math.min(0.99, Math.max(0.01, p));

/** Chance the candle closes green from price action alone (plus the open forecast's lean). */
export function liveMath(prior: number, move: number, sd: number, frac: number): number {
  const f = Math.min(1, Math.max(0.005, frac));
  const drift = sd * (logit(prior) / 1.702) * f;
  return clamp(normCdf((move + drift) / (sd * Math.sqrt(f))));
}

/** Wilder ATR(14) for every candle, by open time. */
export function atrByTime(candles: Candle[]): Map<number, number> {
  const out = new Map<number, number>();
  let atr: number | null = null;
  const seed: number[] = [];
  candles.forEach((c, i) => {
    const pc = i ? candles[i - 1].close : null;
    const tr = pc === null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (atr === null) {
      seed.push(tr);
      if (seed.length === 14) atr = seed.reduce((a, v) => a + v, 0) / 14;
    } else atr = (tr + 13 * atr) / 14;
    if (atr !== null) out.set(c.time, atr);
  });
  return out;
}

/** Typical size of a candle body (close − open) over recent candles. */
export function bodySd(candles: Candle[]): number | null {
  const b = candles.slice(-100).map((c) => c.close - c.open);
  if (b.length < 30) return null;
  const m = b.reduce((a, v) => a + v, 0) / b.length;
  const sd = Math.sqrt(b.reduce((a, v) => a + (v - m) ** 2, 0) / (b.length - 1));
  return sd > 0 ? sd : null;
}

export interface FlipInput {
  forming: Candle; //    the candle so far
  secondsLeft: number;
  tfSeconds: number;
  atr: number; //        recent average true range, dollars
  sd: number; //         typical candle body spread, dollars
  previous: Candle[]; // a few closed candles before it, oldest first
}

/** What Jev sees: only the candle so far and its immediate context, in ATR units. No prices, no dates, no math. */
export function flipState(x: FlipInput): Record<string, unknown> | null {
  const f = x.forming;
  const move = f.close - f.open;
  if (move === 0) return null; // no color yet, nothing to flip
  const color = move > 0 ? "green" : "red";
  const frac = Math.max(0.005, x.secondsLeft / x.tfSeconds);
  return {
    how_to_read: "Sizes are in ATR units (average 15-minute candle range), measured from this candle's open.",
    current_color: color,
    move_so_far: r2(move / x.atr),
    high_so_far: r2((f.high - f.open) / x.atr),
    low_so_far: r2((f.low - f.open) / x.atr),
    pulled_back_from_extreme: r2((move > 0 ? f.high - f.close : f.close - f.low) / x.atr),
    seconds_left: Math.round(x.secondsLeft),
    typical_move_in_time_left: r2((x.sd * Math.sqrt(frac)) / x.atr),
    last_3_candles: x.previous.slice(-3).map((c) => ({
      c: c.close > c.open ? "G" : c.close < c.open ? "R" : "D",
      body: r2((c.close - c.open) / x.atr),
      range: r2((c.high - c.low) / x.atr),
    })),
  };
}

/** Turn Jev's flip chance into a chance of closing green, given the candle's current color. */
export function greenFromFlip(move: number, pFlip: number): number {
  return clamp(move > 0 ? 1 - pFlip : pFlip);
}

export interface FlipRecords {
  math: TrackRecord;
  jev: TrackRecord;
  blend: TrackRecord;
}

/** Learns how much to trust the math vs Jev's flip read, and keeps their records. */
export class FlipBlender {
  private stacker = new Stacker();
  private live = { math: new Tracker(), jev: new Tracker(), blend: new Tracker() };
  constructor(readonly edge = 0.55) {
    this.stacker.wJev = 0.5; // Jev starts at half weight until its record says otherwise
  }
  private callFor(p: number): -1 | 0 | 1 {
    return p >= this.edge ? 1 : p <= 1 - this.edge ? -1 : 0;
  }
  blend(pMath: number, pJevGreen: number | null): number {
    return pJevGreen === null ? pMath : clamp(this.stacker.predict(pMath, pJevGreen));
  }
  get weights() {
    return { math: this.stacker.wModel, jev: this.stacker.wJev };
  }
  /** Score one read against the candle's final color and learn from it. */
  private score(t: { math: Tracker; jev: Tracker; blend: Tracker }, pMath: number, pJev: number, y: 0 | 1) {
    const pb = this.blend(pMath, pJev);
    t.math.record(pMath, this.callFor(pMath), y);
    t.jev.record(pJev, this.callFor(pJev), y);
    t.blend.record(pb, this.callFor(pb), y);
    this.stacker.update(pMath, pJev, y);
  }
  /** Replay on past candles (oldest first) before going live. */
  backfill(rows: { pMath: number; pJev: number; y: 0 | 1 }[]): FlipRecords {
    const t = { math: new Tracker(), jev: new Tracker(), blend: new Tracker() };
    for (const r of rows) this.score(t, r.pMath, r.pJev, r.y);
    return { math: t.math.summary(), jev: t.jev.summary(), blend: t.blend.summary() };
  }
  /** One live read per candle (taken mid-candle), scored when the candle closes. */
  recordLive(pMath: number, pJev: number, y: 0 | 1): FlipRecords {
    this.score(this.live, pMath, pJev, y);
    return { math: this.live.math.summary(), jev: this.live.jev.summary(), blend: this.live.blend.summary() };
  }
}

/**
 * Rebuild past candles at a point partway through, from 1-minute bars, for the Jev replay.
 * Returns one sample per candle at a deterministic "random" minute between 2 and 12.
 */
export function pastSnapshots(
  minutes: Candle[],
  closed: Candle[],
  tfSeconds: number,
  atrAt: (t: number) => number | null,
  priorAt: (t: number) => number,
  count = 150,
) {
  const byCandle = new Map<number, Candle[]>();
  for (const m of minutes) {
    const t = Math.floor(m.time / tfSeconds) * tfSeconds;
    const list = byCandle.get(t) ?? [];
    list.push(m);
    byCandle.set(t, list);
  }
  const out: { time: number; state: Record<string, unknown>; pMath: number; move: number; y: 0 | 1 }[] = [];
  const idx = new Map(closed.map((c, i) => [c.time, i]));
  const recent = closed.slice(-count - 1, -1);
  for (const c of recent) {
    if (c.close === c.open) continue;
    const mins = (byCandle.get(c.time) ?? []).sort((a, b) => a.time - b.time);
    if (mins.length < 13) continue;
    const minute = 2 + ((c.time / tfSeconds) % 11); // 2..12, varies by candle
    const seen = mins.filter((m) => m.time < c.time + minute * 60);
    if (!seen.length) continue;
    const forming: Candle = {
      time: c.time,
      open: seen[0].open,
      high: Math.max(...seen.map((m) => m.high)),
      low: Math.min(...seen.map((m) => m.low)),
      close: seen[seen.length - 1].close,
    };
    const i = idx.get(c.time)!;
    const before = closed.slice(Math.max(0, i - 100), i);
    const atr = atrAt(c.time);
    const sd = bodySd(before);
    if (!atr || !sd) continue;
    const secondsLeft = tfSeconds - minute * 60;
    const state = flipState({ forming, secondsLeft, tfSeconds, atr, sd, previous: before });
    if (!state) continue;
    out.push({
      time: c.time,
      state,
      pMath: liveMath(priorAt(c.time), forming.close - forming.open, sd, secondsLeft / tfSeconds),
      move: forming.close - forming.open,
      y: c.close > c.open ? 1 : 0,
    });
  }
  return out;
}
