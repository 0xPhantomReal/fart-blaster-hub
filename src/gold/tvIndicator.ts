// Port of the TradingView indicator "Gold Next-Candle Bias (Pyth) + Jev feed" (gold_next_candle.pine, Pine v6),
// line for line, so the website chart shows the same thing TradingView did. Pine's rules are kept, including how it
// treats values that don't exist yet on the first bars (na): a comparison with na is false, arithmetic with na is na.

import type { Candle } from "./indicators";

// ── Inputs (the Pine defaults) ──
export const TV_INPUTS = {
  emaFastLen: 9,
  emaSlowLen: 21,
  rsiLen: 14,
  atrLen: 14,
  minEdge: 0.55,
};

// Pine v6 built-in colors.
export const TV_COLORS = {
  orange: "#FF9800",
  blue: "#2962FF",
  green: "#4CAF50",
  red: "#F23645",
  gray: "#787B86",
  white: "#FFFFFF",
};

type N = number | null; // null = Pine's na

/** ta.ema: SMA of the first `len` values, then the exponential average. */
export function emaSeries(xs: number[], len: number): N[] {
  const out: N[] = [];
  let v: N = null;
  let sum = 0;
  const a = 2 / (len + 1);
  xs.forEach((x, i) => {
    if (v === null) {
      sum += x;
      if (i === len - 1) v = sum / len;
    } else v = a * x + (1 - a) * v;
    out.push(v);
  });
  return out;
}

/** ta.rma over a series that may start with na: seeded with the SMA of the first `len` non-na values in a row. */
export function rmaSeries(xs: N[], len: number): N[] {
  const out: N[] = [];
  let v: N = null;
  let seed: number[] = [];
  for (const x of xs) {
    if (x === null) {
      out.push(v);
      if (v === null) seed = [];
      continue;
    }
    if (v === null) {
      seed.push(x);
      if (seed.length === len) v = seed.reduce((s, y) => s + y, 0) / len;
    } else v = (x + (len - 1) * v) / len;
    out.push(v);
  }
  return out;
}

/** ta.rsi(close, len). */
export function rsiSeries(close: number[], len: number): N[] {
  const ch: N[] = close.map((c, i) => (i === 0 ? null : c - close[i - 1]));
  const up = rmaSeries(
    ch.map((x) => (x === null ? null : Math.max(x, 0))),
    len,
  );
  const dn = rmaSeries(
    ch.map((x) => (x === null ? null : -Math.min(x, 0))),
    len,
  );
  return up.map((u, i) => {
    const d = dn[i];
    if (u === null || d === null) return null;
    return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  });
}

/** ta.atr(len): rma of the true range (first bar: high − low). */
export function atrSeries(c: Candle[], len: number): N[] {
  const tr: N[] = c.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(
          b.high - b.low,
          Math.abs(b.high - c[i - 1].close),
          Math.abs(b.low - c[i - 1].close),
        ),
  );
  return rmaSeries(tr, len);
}

const gt = (a: N, b: N) => a !== null && b !== null && a > b; // na comparisons are false

export interface TvBar {
  time: number;
  emaFast: N;
  emaSlow: N;
  probUp: N;
  bias: -1 | 0 | 1;
}

export interface TvResult {
  bars: TvBar[]; //            one per closed candle
  live: { time: number; emaFast: N; emaSlow: N } | null; // EMAs on the forming candle (Pine plots it live)
  pShow: N; //                 the call for the forming candle = probUp of the last closed bar
  dirTxt: "GREEN" | "RED" | "NO CALL";
  calls: number;
  hits: number;
  bars_: number;
  greens: number;
}

/** Run the indicator over the closed candles (oldest first), plus the forming one for the live EMA values. */
export function runTvIndicator(
  closed: Candle[],
  forming: Candle | null,
  inp = TV_INPUTS,
): TvResult {
  const close = closed.map((c) => c.close);
  const emaFast = emaSeries(close, inp.emaFastLen);
  const emaSlow = emaSeries(close, inp.emaSlowLen);
  const rsi = rsiSeries(close, inp.rsiLen);
  const atr = atrSeries(closed, inp.atrLen);

  const bars: TvBar[] = [];
  let streak = 0;
  let calls = 0;
  let hits = 0;
  let nBars = 0;
  let greens = 0;
  closed.forEach((c, i) => {
    const rng = c.high - c.low;
    const closeLocation = rng > 0 ? (c.close - c.low) / rng : 0.5;
    const isGreen = c.close > c.open;
    const isRed = c.close < c.open;
    streak = isGreen
      ? streak > 0
        ? streak + 1
        : 1
      : isRed
        ? streak < 0
          ? streak - 1
          : -1
        : 0;

    const trendScore =
      (gt(c.close, emaSlow[i]) ? 0.35 : -0.35) +
      (gt(emaFast[i], emaSlow[i]) ? 0.25 : -0.25);
    const r = rsi[i];
    const a = atr[i];
    const ef = emaFast[i];
    const momentum = r === null ? null : ((r - 50) / 50) * 0.6;
    const meanRevert = gt(r, 70) ? -0.5 : r !== null && r < 30 ? 0.5 : 0;
    const closeScore = (closeLocation - 0.5) * 0.6;
    const exhaustion = Math.abs(streak) >= 4 ? -Math.sign(streak) * 0.3 : 0;
    // atr > 0 ? clamp((close − emaFast) / atr) : 0 — na atr → 0; na emaFast → na
    const stretchAtr = gt(a, 0)
      ? ef === null
        ? null
        : Math.max(Math.min((c.close - ef) / a!, 2), -2)
      : 0;
    const extension = stretchAtr === null ? null : -stretchAtr * 0.15;

    const score =
      momentum === null || extension === null
        ? null
        : trendScore +
          momentum +
          meanRevert +
          closeScore +
          exhaustion +
          extension;
    const probUp = score === null ? null : 1 / (1 + Math.exp(-score));
    const bias: -1 | 0 | 1 =
      probUp !== null && probUp >= inp.minEdge
        ? 1
        : probUp !== null && probUp <= 1 - inp.minEdge
          ? -1
          : 0;

    // Track record (every closed bar is confirmed): did the previous bar's call get this bar right?
    nBars += 1;
    greens += isGreen ? 1 : 0;
    const prevBias = i > 0 ? bars[i - 1].bias : 0;
    if (prevBias !== 0) {
      calls += 1;
      if ((prevBias === 1 && isGreen) || (prevBias === -1 && isRed)) hits += 1;
    }
    bars.push({ time: c.time, emaFast: ef, emaSlow: emaSlow[i], probUp, bias });
  });

  // The forming candle: the EMAs move with its current close (as TradingView plots them live).
  let live: TvResult["live"] = null;
  if (
    forming &&
    closed.length &&
    forming.time > closed[closed.length - 1].time
  ) {
    const step = (prev: N, len: number) =>
      prev === null
        ? null
        : (2 / (len + 1)) * forming.close + (1 - 2 / (len + 1)) * prev;
    live = {
      time: forming.time,
      emaFast: step(emaFast[emaFast.length - 1], inp.emaFastLen),
      emaSlow: step(emaSlow[emaSlow.length - 1], inp.emaSlowLen),
    };
  }
  // A forming candle is always on screen, so the table shows the call made at the last close ("This candle").
  const pShow = bars.length ? bars[bars.length - 1].probUp : null;
  const dirTxt =
    pShow !== null && pShow >= inp.minEdge
      ? "GREEN"
      : pShow !== null && pShow <= 1 - inp.minEdge
        ? "RED"
        : "NO CALL";
  return { bars, live, pShow, dirTxt, calls, hits, bars_: nBars, greens };
}
