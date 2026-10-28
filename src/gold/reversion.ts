// Measures how much of a candle's early move survives to the close, from real 1-minute history.
//
// For every 15-minute candle in the history and every minute k into it, we compare the move so far
// (close of minute k − open) with the final body (close − open), both in ATR units. A least-squares
// fit  final ≈ hold[k] × move_k  gives the hold ratio:
//   hold < 1  → moves tend to partly revert by the close (mean reversion)
//   hold ≈ 1  → no tendency either way (random walk)
//   hold > 1  → moves tend to extend (momentum)
// The leftover spread, spread[k], is how far the close typically lands from that expectation.

import type { Candle } from "./indicators";

export interface ReversionFit {
  minutesPerCandle: number;
  hold: number[]; //   index e = minutes elapsed in the candle (0..m); e = m is the close
  spread: number[]; // residual sd of the final body given the move at minute e, in ATR units
  candles: number; //  how many candles the fit used
}

/** Roll 1-minute bars into clock-aligned candles of `tfSec`, keeping the minute path for each. */
function bucketMinutes(minutes: Candle[], tfSec: number) {
  const out: { time: number; mins: Candle[] }[] = [];
  for (const m of minutes) {
    const t = Math.floor(m.time / tfSec) * tfSec;
    const cur = out[out.length - 1];
    if (cur && cur.time === t) cur.mins.push(m);
    else out.push({ time: t, mins: [m] });
  }
  return out;
}

export function fitReversion(minutes: Candle[], tfSec: number, minCandles = 150): ReversionFit | null {
  const m = Math.round(tfSec / 60);
  const buckets = bucketMinutes(minutes, tfSec);

  // ATR(14, Wilder) on the rolled-up candles, so units match the live engine.
  let atr: number | null = null;
  let seed: number[] = [];
  let prevClose: number | null = null;
  const sxy = new Array(m + 1).fill(0);
  const sxx = new Array(m + 1).fill(0);
  const rows: { x: number[]; y: number }[] = [];

  for (const b of buckets) {
    const full = b.mins.length >= m - 1; // allow one missing minute
    const open = b.mins[0].open;
    const close = b.mins[b.mins.length - 1].close;
    const high = Math.max(...b.mins.map((x) => x.high));
    const low = Math.min(...b.mins.map((x) => x.low));

    if (full && atr && atr > 0) {
      // Price e minutes in = close of the minute bar that ends then (a missing minute keeps the previous price).
      const at = new Array(m + 1).fill(NaN);
      at[0] = open;
      for (const x of b.mins) at[Math.min(m, Math.floor((x.time - b.time) / 60) + 1)] = x.close;
      for (let e = 1; e <= m; e++) if (Number.isNaN(at[e])) at[e] = at[e - 1];
      const y = (close - open) / atr;
      const xs = at.map((c) => (c - open) / atr!);
      rows.push({ x: xs, y });
      for (let e = 0; e <= m; e++) {
        sxy[e] += xs[e] * y;
        sxx[e] += xs[e] * xs[e];
      }
    }

    const tr = prevClose === null ? high - low : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    if (atr === null) {
      seed.push(tr);
      if (seed.length === 14) {
        atr = seed.reduce((a, v) => a + v, 0) / 14;
        seed = [];
      }
    } else atr = (tr + 13 * atr) / 14;
    prevClose = close;
  }

  if (rows.length < minCandles) return null;
  // At the open no move exists yet (spread = the full body spread); at the close the body is known (spread 0).
  const hold = sxy.map((v, e) => (e === 0 || e === m || sxx[e] === 0 ? 1 : v / sxx[e]));
  const spread = hold.map((h, e) => {
    if (e === m) return 0;
    const ss = rows.reduce((a, r) => a + (r.y - (e === 0 ? 0 : h * r.x[e])) ** 2, 0);
    return Math.sqrt(ss / rows.length);
  });
  return { minutesPerCandle: m, hold, spread, candles: rows.length };
}

/** Hold ratio and spread at a fractional number of minutes into the candle (linear interpolation). */
export function reversionAt(fit: ReversionFit, minutesIn: number): { hold: number; spread: number } {
  const m = fit.minutesPerCandle;
  const t = Math.max(0, Math.min(m, minutesIn));
  const i = Math.min(m - 1, Math.floor(t));
  const w = t - i;
  return {
    hold: fit.hold[i] * (1 - w) + fit.hold[i + 1] * w,
    spread: fit.spread[i] * (1 - w) + fit.spread[i + 1] * w,
  };
}
