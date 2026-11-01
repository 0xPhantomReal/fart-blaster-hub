// Extra market context for Jev's next-candle call: the bigger picture a trader would look at before the next
// candle opens. Built only from data known at that moment (closed candles, plus bitcoin volume when available),
// so Jev's past-candle test stays fair. Sizes are in ATR units of the chart's timeframe: no prices, no dates.

import type { Candle } from "./indicators";

const r2 = (v: number) => Number(v.toFixed(2));
const DAY = 86400;

/** Round-number spacing that traders watch, per market. */
const ROUND: Record<string, number> = { gold: 10, btc: 500, eth: 50, sol: 5, xrp: 0.05 };

/** Group candles into longer ones (e.g. 1h or 4h), oldest first. */
function group(cs: Candle[], sec: number): Candle[] {
  const out: Candle[] = [];
  for (const c of cs) {
    const t = Math.floor(c.time / sec) * sec;
    const cur = out[out.length - 1];
    if (cur && cur.time === t) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    } else out.push({ ...c, time: t });
  }
  return out;
}

const describe = (c: Candle, atr: number) => ({
  c: c.close > c.open ? "G" : c.close < c.open ? "R" : "D",
  body: r2((c.close - c.open) / atr),
  range: r2((c.high - c.low) / atr),
});

/** Index of the last candle that opened before `t` (binary search; candles sorted by time). */
export function lastBefore(cs: Candle[], t: number): number {
  let lo = 0;
  let hi = cs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].time < t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface ContextInput {
  closed: Candle[]; //              closed candles, oldest first (may extend past forTime; only earlier ones are used)
  forTime: number; //               open time of the candle Jev is asked about
  tfSeconds: number;
  atr: number | null; //            ATR(14) as of the last closed candle
  market: string;
  volume?: Map<number, number>; //  volume per candle open time (bitcoin, from Coinbase), if available
}

/** Everything extra Jev gets for the candle opening at `forTime`. Null if there isn't enough history. */
export function marketContext(x: ContextInput): Record<string, unknown> | null {
  const end = lastBefore(x.closed, x.forTime);
  const atr = x.atr;
  if (end < 60 || !atr || atr <= 0) return null;
  const cs = x.closed.slice(Math.max(0, end - 2000), end + 1); // ~enough for a few days on 5m/15m
  const last = cs[cs.length - 1];
  const price = last.close;
  const a = (v: number) => r2(v / atr);

  // Day levels (UTC days).
  const dayStart = Math.floor(x.forTime / DAY) * DAY;
  const today = cs.filter((c) => c.time >= dayStart);
  const yesterday = cs.filter((c) => c.time >= dayStart - DAY && c.time < dayStart);
  const last24 = cs.filter((c) => c.time >= x.forTime - DAY);
  const hi = (l: Candle[]) => Math.max(...l.map((c) => c.high));
  const lo = (l: Candle[]) => Math.min(...l.map((c) => c.low));

  const levels: Record<string, number> = {};
  if (today.length) {
    levels.vs_today_open = a(price - today[0].open);
    levels.below_today_high = a(hi(today) - price);
    levels.above_today_low = a(price - lo(today));
  }
  if (yesterday.length) {
    levels.vs_yesterday_high = a(price - hi(yesterday));
    levels.vs_yesterday_low = a(price - lo(yesterday));
    levels.vs_yesterday_close = a(price - yesterday[yesterday.length - 1].close);
  }
  if (last24.length) {
    levels.below_24h_high = a(hi(last24) - price);
    levels.above_24h_low = a(price - lo(last24));
  }
  const step = ROUND[x.market];
  if (step) {
    const below = Math.floor(price / step) * step;
    levels.above_round_number = a(price - below);
    levels.below_round_number = a(below + step - price);
  }

  // Volatility regime: is the market quieter or wilder than usual?
  const ranges = cs.slice(-50).map((c) => c.high - c.low);
  const avgRange = ranges.reduce((s, v) => s + v, 0) / ranges.length;
  const recentRange = cs.slice(-10).reduce((s, c) => s + (c.high - c.low), 0) / 10;
  const volatility = {
    atr_vs_50_candle_avg_range: r2(atr / avgRange),
    last_10_vs_last_50_range: r2(recentRange / avgRange),
  };

  // Longer timeframes.
  const hourly = group(cs, 3600).slice(-9, -1); //    last 8 complete-ish hours (the current hour may be partial)
  const fourHour = group(cs, 14400).slice(-7, -1);
  const d = new Date(x.forTime * 1000);

  const out: Record<string, unknown> = {
    context_how_to_read:
      "levels: signed distances from the current price in ATR units (vs_* > 0 means price is above that level). " +
      "volatility: ratios (1 = normal). hourly/four_hour: longer candles, oldest first, sizes in ATR units.",
    levels,
    volatility,
    hourly_last_8: hourly.map((c) => describe(c, atr)),
    four_hour_last_6: fourHour.map((c) => describe(c, atr)),
    weekday_utc: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()],
    hour_utc: d.getUTCHours(),
  };

  // Volume (bitcoin): is participation rising, and is it coming in on up or down candles?
  if (x.volume) {
    const recent = cs.slice(-20).map((c) => ({ c, v: x.volume!.get(c.time) }));
    if (recent.every((r) => r.v !== undefined) && recent.length === 20) {
      const vs = recent.map((r) => r.v!);
      const avg = vs.reduce((s, v) => s + v, 0) / 20;
      const last12 = recent.slice(-12);
      const upVol = last12.filter((r) => r.c.close > r.c.open).reduce((s, r) => s + r.v!, 0);
      const tot = last12.reduce((s, r) => s + r.v!, 0);
      if (avg > 0 && tot > 0) {
        out.volume = {
          how_to_read: "Coinbase volume. Ratios: 1 = average of the last 20 candles.",
          last_candle_vs_avg: r2(vs[19] / avg),
          last_3_vs_avg: r2(vs.slice(-3).reduce((s, v) => s + v, 0) / 3 / avg),
          last_5_vs_previous_15: r2(vs.slice(-5).reduce((s, v) => s + v, 0) / 5 / (vs.slice(0, 15).reduce((s, v) => s + v, 0) / 15)),
          share_on_green_candles_last_12: r2(upVol / tot),
          per_candle_last_12: last12.map((r) => ({ c: r.c.close > r.c.open ? "G" : r.c.close < r.c.open ? "R" : "D", v: r2(r.v! / avg) })),
        };
      }
    }
  }
  return out;
}
