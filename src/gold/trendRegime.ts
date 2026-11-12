// Historical trend shading: the bot's auto-mode trend check (supabase/functions/_shared/fadeStrategy.ts trendSummary)
// replayed for every past 5-minute candle, as it would have looked at that candle's open — so the chart can show where
// auto mode would have gone straight with Jev (strong trend) and where it would have flipped.
import { emaSeries, TV_INPUTS } from "./tvIndicator";

type Ohlc = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** Copy of the bot's trendSummary label logic (kept identical by a test). */
export function trendLabel(
  closed: Ohlc[],
  price: number,
  emaFast: number | null,
  emaSlow: number | null,
  atr: number | null,
) {
  const last12 = closed.slice(-12);
  const reds = last12.filter((c) => c.close < c.open).length;
  const greens = last12.filter((c) => c.close > c.open).length;
  const last6 = closed.slice(-6);
  let lowerHighs = 0;
  let higherLows = 0;
  for (let i = 1; i < last6.length; i++) {
    if (last6[i].high < last6[i - 1].high) lowerHighs += 1;
    if (last6[i].low > last6[i - 1].low) higherLows += 1;
  }
  const net12 = last12.length ? price - last12[0].open : 0;
  const emaDir =
    emaFast === null || emaSlow === null
      ? null
      : emaFast > emaSlow
        ? "up"
        : emaFast < emaSlow
          ? "down"
          : "flat";
  const vsSlow =
    emaSlow === null
      ? null
      : price > emaSlow
        ? "above"
        : price < emaSlow
          ? "below"
          : "at";
  const down =
    (emaDir === "down" ? 1 : 0) +
    (vsSlow === "below" ? 1 : 0) +
    (reds >= 8 ? 1 : 0) +
    (lowerHighs >= 4 ? 1 : 0) +
    (net12 < 0 && atr && -net12 > 2 * atr ? 1 : 0);
  const up =
    (emaDir === "up" ? 1 : 0) +
    (vsSlow === "above" ? 1 : 0) +
    (greens >= 8 ? 1 : 0) +
    (higherLows >= 4 ? 1 : 0) +
    (net12 > 0 && atr && net12 > 2 * atr ? 1 : 0);
  const label =
    down >= 4
      ? "strong downtrend"
      : down >= 3 && down > up
        ? "downtrend"
        : up >= 4
          ? "strong uptrend"
          : up >= 3 && up > down
            ? "uptrend"
            : "no clear trend";
  return { label, down, up };
}

export type Regime =
  | "strong downtrend"
  | "downtrend"
  | "strong uptrend"
  | "uptrend"
  | "no clear trend";

/** The trend label for each candle (by its time), judged at its open: closed candles before it, price = its open. */
export function trendRegimes(
  candles: Ohlc[],
): Map<number, { label: Regime; down: number; up: number }> {
  const out = new Map<number, { label: Regime; down: number; up: number }>();
  if (candles.length < 30) return out;
  const closes = candles.map((c) => c.close);
  const fast = emaSeries(closes, TV_INPUTS.emaFastLen);
  const slow = emaSeries(closes, TV_INPUTS.emaSlowLen);
  const aF = 2 / (TV_INPUTS.emaFastLen + 1);
  const aS = 2 / (TV_INPUTS.emaSlowLen + 1);
  for (let i = 25; i < candles.length; i++) {
    const price = candles[i].open;
    // Live EMAs on the forming candle at its open (its close so far = its open), as the bot's EMAs move live.
    const pf = fast[i - 1];
    const ps = slow[i - 1];
    const emaF = pf === null ? null : aF * price + (1 - aF) * pf;
    const emaS = ps === null ? null : aS * price + (1 - aS) * ps;
    // ATR as Lightspeed has it: mean true range of the last 14 closed candles.
    const w = candles.slice(Math.max(0, i - 14), i);
    const tr = w.map((c, j) =>
      j === 0
        ? c.high - c.low
        : Math.max(
            c.high - c.low,
            Math.abs(c.high - w[j - 1].close),
            Math.abs(c.low - w[j - 1].close),
          ),
    );
    const atr = tr.length ? tr.reduce((s, x) => s + x, 0) / tr.length : null;
    const r = trendLabel(
      candles.slice(Math.max(0, i - 12), i),
      price,
      emaF,
      emaS,
      atr,
    );
    out.set(candles[i].time, r as { label: Regime; down: number; up: number });
  }
  return out;
}

export const REGIME_COLORS: Record<Regime, string> = {
  "strong downtrend": "rgba(239,83,80,0.22)",
  downtrend: "rgba(239,83,80,0.07)",
  "strong uptrend": "rgba(38,166,154,0.22)",
  uptrend: "rgba(38,166,154,0.07)",
  "no clear trend": "rgba(0,0,0,0)",
};
