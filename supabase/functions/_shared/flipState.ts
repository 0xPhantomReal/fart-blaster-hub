// Copy of the candle-reading pieces of src/gold/flip.ts, for edge functions (kept identical by
// src/gold/flipParity.test.ts). What Jev sees: sizes in ATR units, no prices, no dates.

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const r2 = (v: number) => Number(v.toFixed(2));
const clamp = (p: number) => Math.min(0.99, Math.max(0.01, p));

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
    how_to_read: "Sizes are in ATR units (average candle range), measured from this candle's open.",
    current_color: color,
    move_so_far: r2(move / x.atr),
    high_so_far: r2((f.high - f.open) / x.atr),
    low_so_far: r2((f.low - f.open) / x.atr),
    pulled_back_from_extreme: r2((move > 0 ? f.high - f.close : f.close - f.low) / x.atr),
    seconds_left: Math.round(x.secondsLeft),
    typical_move_in_time_left: r2((x.sd * Math.sqrt(frac)) / x.atr),
    last_15_candles: x.previous.slice(-15).map((c) => ({
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

