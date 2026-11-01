// Order flow from Coinbase trades: who was the aggressor (buyer lifting the ask, or seller hitting the bid) and
// at what price. Builds volume footprints per candle (buy/sell volume per price level), summaries for Jev, and a
// couple of inputs for "Jev refined".
//
// Coinbase reports the MAKER side of each trade: side "sell" means a resting sell order was hit by an aggressive
// buyer, so it counts as aggressive BUY volume (and "buy" as aggressive SELL volume).

import type { Candle } from "./indicators";

const r2 = (v: number) => Number(v.toFixed(2));

/** One candle's footprint: aggressive buy and sell volume per price level (level = floor(price / step) * step). */
export interface Footprint {
  time: number; //   candle open time
  step: number; //   price-level size
  levels: Record<string, [number, number]>; // level price (as string) → [buy, sell]
  buy: number;
  sell: number;
}

export function emptyFootprint(time: number, step: number): Footprint {
  return { time, step, levels: {}, buy: 0, sell: 0 };
}

/** Add one trade. `aggressiveBuy` = the taker was buying. */
export function addTrade(fp: Footprint, price: number, size: number, aggressiveBuy: boolean) {
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
export function rows(fp: Footprint): { price: number; buy: number; sell: number }[] {
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
  let topB = 0, topS = 0, botB = 0, botS = 0, stacked = 0;
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
    if (r.buy + r.sell > 0 && Math.max(r.buy, r.sell) >= 3 * Math.max(Math.min(r.buy, r.sell), 1e-12)) stacked += r.buy > r.sell ? 1 : -1;
  }
  const share = (b: number, s: number) => (b + s > 0 ? r2((b - s) / (b + s)) : 0);
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
    delta_share_last_6: last6.map((f) => r2((f!.buy - f!.sell) / (f!.buy + f!.sell))),
    volume_last_6_vs_their_avg: vols.map((v) => r2(v / avg)),
  };
  if (fps.every((f) => f && f.buy + f.sell > 0) && recent.length === 20) {
    const b = fps.reduce((s, f) => s + f!.buy, 0);
    const sl = fps.reduce((s, f) => s + f!.sell, 0);
    const cvd = (b - sl) / (b + sl);
    const move = (last.close - recent[0].open) / atr;
    out.cumulative_delta_share_last_20 = r2(cvd);
    out.price_move_last_20_atr = r2(move);
    out.divergence = Math.sign(cvd) !== 0 && Math.sign(move) !== 0 && Math.sign(cvd) !== Math.sign(move)
      ? cvd > 0
        ? "price fell while buyers were more aggressive"
        : "price rose while sellers were more aggressive"
      : "none";
  }
  return out;
}

/** Two inputs for "Jev refined": last candle's delta share and the last-6 average (0 when unknown). */
export function flowInputs(footprints: Map<number, Footprint>, forTime: number, tfSeconds: number): [number, number] {
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

/** Stream Coinbase matches for `product`. Returns a stop function. Reconnects on its own. */
export function coinbaseTrades(product: string, onTrade: (t: Trade) => void, onStatus: (ok: boolean, why?: string) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 1000;
  const open = () => {
    if (stopped) return;
    ws = new WebSocket(import.meta.env.VITE_COINBASE_WS || "wss://ws-feed.exchange.coinbase.com");
    ws.onopen = () => {
      retry = 1000;
      ws!.send(JSON.stringify({ type: "subscribe", product_ids: [product], channels: ["matches"] }));
      onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.type === "match" || m.type === "last_match") {
          onTrade({ t: Date.parse(m.time) / 1000, p: Number(m.price), s: Number(m.size), buy: m.side === "sell" });
        }
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      onStatus(false, "Coinbase trade stream disconnected; reconnecting");
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 30_000);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}

// ── Saved footprints (closed candles never change) ────────────────────

export function loadFootprints(key: string): { step: number; fps: Map<number, Footprint> } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!raw || typeof raw.step !== "number") return null;
    return { step: raw.step, fps: new Map((raw.fps as Footprint[]).map((f) => [f.time, f])) };
  } catch {
    return null;
  }
}

export function saveFootprints(key: string, step: number, fps: Map<number, Footprint>, keep = 300) {
  try {
    const list = [...fps.values()].sort((a, b) => a.time - b.time).slice(-keep);
    localStorage.setItem(key, JSON.stringify({ step, fps: list }));
  } catch {
    // storage full or unavailable: fetched again next visit
  }
}

// ── Trade history: page Coinbase back to `fromTime` in parallel lanes ──

type Page = { trades: [number, number, number, number, number][]; minId: number | null; maxId: number | null };

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
      if (id > lo && id <= hi && t >= fromTime && t < beforeTime) onTrade({ t, p, s, buy: b === 1 });
    }
  };
  const first = await fetchPage(null);
  if (!first.trades.length || first.maxId === null || first.minId === null) return true;
  const maxId = first.maxId;
  const oldestT = Math.min(...first.trades.map((x) => x[0]));
  const newestT = Math.max(...first.trades.map((x) => x[0]));
  if (oldestT <= fromTime) {
    take(first, 0, maxId);
    return true;
  }
  // Estimate the trade id at fromTime, then make sure the page there really starts before fromTime.
  const rate = Math.max(1e-3, (maxId - first.minId) / Math.max(1, newestT - oldestT));
  let startId = Math.max(1, Math.floor(maxId - rate * (newestT - fromTime) * 1.1));
  for (let i = 0; i < 8; i++) {
    const pg = await fetchPage(startId);
    if (!pg.trades.length) break;
    const t = Math.max(...pg.trades.map((x) => x[0]));
    if (t <= fromTime) break;
    startId = Math.max(1, Math.floor(startId - rate * (t - fromTime) * 1.5) - 1000);
  }
  const span = maxId - startId;
  const totalPages = Math.ceil(span / 1000);
  if (totalPages > maxPages) return false;
  let done = 0;
  const bounds = Array.from({ length: lanes }, (_, k) => [startId + Math.floor((span * k) / lanes), startId + Math.floor((span * (k + 1)) / lanes)]);
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
