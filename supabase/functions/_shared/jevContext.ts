// AUTO-COPIED from src/gold/context.ts and src/gold/orderflow.ts (browser-only parts left out) so the Polymarket bot
// sends Jev exactly the context the website sends. Keep in step: src/gold/jevContextParity.test.ts checks they match.

import type { Candle } from "./flipState.ts";

// Extra market context for Jev's next-candle call: the bigger picture a trader would look at before the next
// candle opens. Built only from data known at that moment (closed candles, plus bitcoin volume when available),
// so Jev's past-candle test stays fair. Sizes are in ATR units of the chart's timeframe: no prices, no dates.


const r2 = (v: number) => Number(v.toFixed(2));
const DAY = 86400;

/** Round-number spacing that traders watch, per market. */
const ROUND: Record<string, number> = {
  gold: 10,
  btc: 500,
  eth: 50,
  sol: 5,
  xrp: 0.05,
  bnb: 10,
  doge: 0.01,
  hype: 1,
  zec: 5,
};

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
  const yesterday = cs.filter(
    (c) => c.time >= dayStart - DAY && c.time < dayStart,
  );
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
    levels.vs_yesterday_close = a(
      price - yesterday[yesterday.length - 1].close,
    );
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
  const recentRange =
    cs.slice(-10).reduce((s, c) => s + (c.high - c.low), 0) / 10;
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
    weekday_utc: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
      d.getUTCDay()
    ],
    hour_utc: d.getUTCHours(),
  };

  // Volume (bitcoin): is participation rising, and is it coming in on up or down candles?
  if (x.volume) {
    const recent = cs.slice(-20).map((c) => ({ c, v: x.volume!.get(c.time) }));
    if (recent.every((r) => r.v !== undefined) && recent.length === 20) {
      const vs = recent.map((r) => r.v!);
      const avg = vs.reduce((s, v) => s + v, 0) / 20;
      const last12 = recent.slice(-12);
      const upVol = last12
        .filter((r) => r.c.close > r.c.open)
        .reduce((s, r) => s + r.v!, 0);
      const tot = last12.reduce((s, r) => s + r.v!, 0);
      if (avg > 0 && tot > 0) {
        out.volume = {
          how_to_read:
            "Coinbase volume. Ratios: 1 = average of the last 20 candles.",
          last_candle_vs_avg: r2(vs[19] / avg),
          last_3_vs_avg: r2(vs.slice(-3).reduce((s, v) => s + v, 0) / 3 / avg),
          last_5_vs_previous_15: r2(
            vs.slice(-5).reduce((s, v) => s + v, 0) /
              5 /
              (vs.slice(0, 15).reduce((s, v) => s + v, 0) / 15),
          ),
          share_on_green_candles_last_12: r2(upVol / tot),
          per_candle_last_12: last12.map((r) => ({
            c: r.c.close > r.c.open ? "G" : r.c.close < r.c.open ? "R" : "D",
            v: r2(r.v! / avg),
          })),
        };
      }
    }
  }
  return out;
}

// Order flow from Coinbase trades: who was the aggressor (buyer lifting the ask, or seller hitting the bid) and
// at what price. Builds volume footprints per candle (buy/sell volume per price level), summaries for Jev, and a
// couple of inputs for "Jev refined".
//
// Coinbase reports the MAKER side of each trade: side "sell" means a resting sell order was hit by an aggressive
// buyer, so it counts as aggressive BUY volume (and "buy" as aggressive SELL volume).



/** One candle's footprint: aggressive buy and sell volume per price level (level = floor(price / step) * step). */
export interface Footprint {
  time: number; //   candle open time
  step: number; //   price-level size
  levels: Record<string, [number, number]>; // level price (as string) → [buy, sell]
  buy: number;
  sell: number;
  /** Aggressive [buy, sell] per 30-second slice of the candle ("0" = first 30 s), to rebuild it partway through. */
  slices?: Record<string, [number, number]>;
}

export const SLICE_SECONDS = 30;

export function emptyFootprint(time: number, step: number): Footprint {
  return { time, step, levels: {}, buy: 0, sell: 0 };
}

/** Add one trade. `aggressiveBuy` = the taker was buying. */
export function addTrade(
  fp: Footprint,
  price: number,
  size: number,
  aggressiveBuy: boolean,
  t?: number,
) {
  if (t !== undefined) {
    const k = String(Math.max(0, Math.floor((t - fp.time) / SLICE_SECONDS)));
    const sl = ((fp.slices ??= {})[k] ??= [0, 0]);
    sl[aggressiveBuy ? 0 : 1] += size;
  }
  const lv = Math.floor(price / fp.step) * fp.step;
  const key = lv.toFixed(8);
  const cell = (fp.levels[key] ??= [0, 0]);
  if (aggressiveBuy) {
    cell[0] += size;
    fp.buy += size;
  } else {
    cell[1] += size;
    fp.sell += size;
  }
}

/** A round price-level size giving ~12 levels per average candle. */
export function niceStep(atr: number): number {
  const raw = atr / 12;
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** Levels sorted high → low, as numbers. */
export function rows(
  fp: Footprint,
): { price: number; buy: number; sell: number }[] {
  return Object.entries(fp.levels)
    .map(([k, [buy, sell]]) => ({ price: Number(k), buy, sell }))
    .sort((a, b) => b.price - a.price);
}

/** Point of control: the level with the most volume. */
export function poc(fp: Footprint): number | null {
  let best: number | null = null;
  let bestV = -1;
  for (const r of rows(fp)) {
    if (r.buy + r.sell > bestV) {
      bestV = r.buy + r.sell;
      best = r.price;
    }
  }
  return best === null ? null : best + fp.step / 2;
}

/** Scale-free summary of one candle's order flow. */
export function summarize(fp: Footprint, c: Candle, atr: number) {
  const total = fp.buy + fp.sell;
  if (total <= 0) return null;
  const range = c.high - c.low;
  const top = c.low + range * 0.75;
  const bottom = c.low + range * 0.25;
  let topB = 0,
    topS = 0,
    botB = 0,
    botS = 0,
    stacked = 0;
  for (const r of rows(fp)) {
    const mid = r.price + fp.step / 2;
    if (mid >= top) {
      topB += r.buy;
      topS += r.sell;
    }
    if (mid <= bottom) {
      botB += r.buy;
      botS += r.sell;
    }
    if (
      r.buy + r.sell > 0 &&
      Math.max(r.buy, r.sell) >= 3 * Math.max(Math.min(r.buy, r.sell), 1e-12)
    )
      stacked += r.buy > r.sell ? 1 : -1;
  }
  const share = (b: number, s: number) =>
    b + s > 0 ? r2((b - s) / (b + s)) : 0;
  const p = poc(fp);
  return {
    delta_share: r2((fp.buy - fp.sell) / total), //                 +1 all aggressive buying, −1 all selling
    delta_share_top_quarter: share(topB, topS), //                  who was aggressive near the high
    delta_share_bottom_quarter: share(botB, botS), //               … near the low
    poc_position: p === null || range <= 0 ? 0.5 : r2((p - c.low) / range), // 0 = most volume at the low, 1 = high
    close_vs_poc: p === null ? 0 : r2((c.close - p) / atr),
    one_sided_levels: stacked, //                                    + = more levels dominated 3:1 by buyers
  };
}

/** Order-flow block for Jev's next-candle question, from candles closed before `forTime`. */
export function flowContext(
  closed: Candle[],
  footprints: Map<number, Footprint>,
  forTime: number,
  tfSeconds: number,
  atr: number | null,
): Record<string, unknown> | null {
  if (!atr) return null;
  const recent = closed.filter((c) => c.time < forTime).slice(-20);
  const last = recent[recent.length - 1];
  if (!last || last.time !== forTime - tfSeconds) return null;
  const fps = recent.map((c) => footprints.get(c.time));
  const last6 = fps.slice(-6);
  if (last6.some((f) => !f || f.buy + f.sell <= 0)) return null;
  const lastFp = fps[fps.length - 1]!;
  const vols = last6.map((f) => f!.buy + f!.sell);
  const avg = vols.reduce((s, v) => s + v, 0) / vols.length;
  const out: Record<string, unknown> = {
    order_flow_how_to_read:
      "From Coinbase trades. delta_share = (aggressive buy − aggressive sell) / total, −1…+1. poc = price with the most volume. Lists oldest first.",
    last_candle: summarize(lastFp, last, atr),
    delta_share_last_6: last6.map((f) =>
      r2((f!.buy - f!.sell) / (f!.buy + f!.sell)),
    ),
    volume_last_6_vs_their_avg: vols.map((v) => r2(v / avg)),
  };
  if (fps.every((f) => f && f.buy + f.sell > 0) && recent.length === 20) {
    const b = fps.reduce((s, f) => s + f!.buy, 0);
    const sl = fps.reduce((s, f) => s + f!.sell, 0);
    const cvd = (b - sl) / (b + sl);
    const move = (last.close - recent[0].open) / atr;
    out.cumulative_delta_share_last_20 = r2(cvd);
    out.price_move_last_20_atr = r2(move);
    out.divergence =
      Math.sign(cvd) !== 0 &&
      Math.sign(move) !== 0 &&
      Math.sign(cvd) !== Math.sign(move)
        ? cvd > 0
          ? "price fell while buyers were more aggressive"
          : "price rose while sellers were more aggressive"
        : "none";
  }
  return out;
}

/** Two inputs for "Jev refined": last candle's delta share and the last-6 average (0 when unknown). */
export function flowInputs(
  footprints: Map<number, Footprint>,
  forTime: number,
  tfSeconds: number,
): [number, number] {
  const ds: number[] = [];
  for (let k = 1; k <= 6; k++) {
    const f = footprints.get(forTime - k * tfSeconds);
    if (!f || f.buy + f.sell <= 0) break;
    ds.push((f.buy - f.sell) / (f.buy + f.sell));
  }
  if (!ds.length) return [0, 0];
  return [ds[0], ds.reduce((s, v) => s + v, 0) / ds.length];
}

// ── Live trades: Coinbase public websocket (no key) ───────────────────

export interface Trade {
  t: number; //   unix seconds
  p: number;
  s: number;
  buy: boolean; // aggressive buy
}

// ── Trade history: page Coinbase back to `fromTime` in parallel lanes ──

type Page = {
  trades: [number, number, number, number, number][];
  minId: number | null;
  maxId: number | null;
};

/**
 * Fetch every trade from `fromTime` up to `beforeTime` (exclusive) and hand each to `onTrade`. Coinbase only pages
 * by trade id, so first estimate the trade id at `fromTime` from the trading rate, then split the id range into
 * lanes fetched in parallel. Gives up after `maxPages` (returns false).
 */
export async function loadTradeHistory(
  fetchPage: (after: number | null) => Promise<Page>,
  fromTime: number,
  beforeTime: number,
  onTrade: (t: Trade) => void,
  onProgress: (done: number, total: number) => void,
  lanes = 4,
  maxPages = 900,
): Promise<boolean> {
  const take = (pg: Page, lo: number, hi: number) => {
    for (const [t, p, s, b, id] of pg.trades) {
      if (id > lo && id <= hi && t >= fromTime && t < beforeTime)
        onTrade({ t, p, s, buy: b === 1 });
    }
  };
  const first = await fetchPage(null);
  if (!first.trades.length || first.maxId === null || first.minId === null)
    return true;
  const maxId = first.maxId;
  const oldestT = Math.min(...first.trades.map((x) => x[0]));
  const newestT = Math.max(...first.trades.map((x) => x[0]));
  if (oldestT <= fromTime) {
    take(first, 0, maxId);
    return true;
  }
  // Estimate the trade id at fromTime, then make sure the page there really starts before fromTime.
  const rate = Math.max(
    1e-3,
    (maxId - first.minId) / Math.max(1, newestT - oldestT),
  );
  let startId = Math.max(
    1,
    Math.floor(maxId - rate * (newestT - fromTime) * 1.1),
  );
  for (let i = 0; i < 8; i++) {
    const pg = await fetchPage(startId);
    if (!pg.trades.length) break;
    const t = Math.max(...pg.trades.map((x) => x[0]));
    if (t <= fromTime) break;
    startId = Math.max(
      1,
      Math.floor(startId - rate * (t - fromTime) * 1.5) - 1000,
    );
  }
  const span = maxId - startId;
  const totalPages = Math.ceil(span / 1000);
  if (totalPages > maxPages) return false;
  let done = 0;
  const bounds = Array.from({ length: lanes }, (_, k) => [
    startId + Math.floor((span * k) / lanes),
    startId + Math.floor((span * (k + 1)) / lanes),
  ]);
  await Promise.all(
    bounds.map(async ([lo, hi]) => {
      let after = hi + 1;
      while (after > lo + 1) {
        const pg = await fetchPage(after);
        if (!pg.trades.length || pg.minId === null) break;
        take(pg, lo, hi);
        after = pg.minId;
        onProgress(++done, totalPages);
      }
    }),
  );
  return true;
}

/**
 * Order flow of a candle in its first `elapsed` seconds (whole 30-second slices only), compared with the average
 * full-candle volume of `recent` footprints. Null when the candle has no slice data.
 */
export function flowSoFar(
  fp: Footprint | undefined,
  elapsed: number,
  recent: (Footprint | undefined)[],
) {
  if (!fp?.slices) return null;
  const upTo = Math.floor(elapsed / SLICE_SECONDS);
  let b = 0;
  let s = 0;
  const per: number[] = [];
  for (let i = 0; i < upTo; i++) {
    const x = fp.slices[String(i)] ?? [0, 0];
    b += x[0];
    s += x[1];
    per.push(
      x[0] + x[1] > 0 ? Number(((x[0] - x[1]) / (x[0] + x[1])).toFixed(2)) : 0,
    );
  }
  if (b + s <= 0) return null;
  const vols = recent
    .filter((f): f is Footprint => !!f && f.buy + f.sell > 0)
    .map((f) => f.buy + f.sell);
  const avg = vols.length ? vols.reduce((a, v) => a + v, 0) / vols.length : 0;
  return {
    how_to_read:
      "Coinbase trades since this candle opened. delta_share = (aggressive buy − aggressive sell) / total, −1…+1. volume_vs_typical_candle: volume so far ÷ an average whole candle's volume.",
    delta_share: Number(((b - s) / (b + s)).toFixed(2)),
    delta_share_per_30s: per,
    volume_vs_typical_candle:
      avg > 0 ? Number(((b + s) / avg).toFixed(2)) : null,
  };
}
