// Jerico: rebuild the 5-minute Polymarket market tick by tick from the recorder's chunks.
export type Side = "up" | "down";
export interface Chunk {
  seq: number;
  t0: number; // ms
  rows: number[][];
}
export interface BookTick {
  t: number; // ms epoch
  bid: number;
  ask: number;
  bidSz: number;
  askSz: number;
}
export interface TradeTick {
  t: number;
  px: number;
  qty: number;
  /** The aggressor bought THIS side (the one being viewed). */
  takerBought: boolean;
}

/**
 * Chunks (YES prices) → ticks for the side being viewed. YES pays on `longIs`; the other side's bid is 1 − YES ask,
 * its ask 1 − YES bid, and a taker buying YES is selling it.
 */
export function decode(chunks: Chunk[], longIs: Side, view: Side): { book: BookTick[]; trades: TradeTick[] } {
  const same = view === longIs;
  const book: BookTick[] = [], trades: TradeTick[] = [];
  for (const c of [...chunks].sort((a, b) => a.seq - b.seq)) {
    for (const r of c.rows) {
      const t = c.t0 + r[0];
      if (r[1] === 0) {
        const [bid, bidSz, ask, askSz] = r.slice(2);
        book.push(same ? { t, bid, ask, bidSz, askSz } : { t, bid: r4(1 - ask), ask: r4(1 - bid), bidSz: askSz, askSz: bidSz });
      } else if (r[1] === 1) {
        const [px, qty, yes] = r.slice(2);
        trades.push({ t, px: same ? px : r4(1 - px), qty, takerBought: same ? yes === 1 : yes !== 1 });
      }
    }
  }
  book.sort((a, b) => a.t - b.t);
  trades.sort((a, b) => a.t - b.t);
  return { book, trades };
}

export interface Candle {
  t: number; // bucket start, ms
  o: number;
  h: number;
  l: number;
  c: number;
  ticks: number;
}

/** OHLC of the mid price per bucket. Buckets with no tick carry the previous close (the price didn't move). */
export function candles(book: BookTick[], from: number, to: number, bucketMs: number): Candle[] {
  const out: Candle[] = [];
  if (!book.length) return out;
  let i = 0, last: number | null = null;
  const first = Math.floor(Math.max(from, book[0].t) / bucketMs) * bucketMs;
  for (let b = first; b < to; b += bucketMs) {
    let o: number | null = last, h = -1, l = 2, c: number | null = last, n = 0;
    while (i < book.length && book[i].t < b + bucketMs) {
      const m = (book[i].bid + book[i].ask) / 2;
      if (book[i].t >= b) {
        if (o === null) o = m;
        h = Math.max(h, m);
        l = Math.min(l, m);
        n++;
      }
      c = m;
      i++;
    }
    if (c === null) continue;
    if (o === null) o = c;
    h = Math.max(h, o, c);
    l = Math.min(l, o, c);
    out.push({ t: b, o, h, l, c, ticks: n });
    last = c;
    if (i >= book.length && b + bucketMs > book[book.length - 1].t) break;
  }
  return out;
}

export interface FlowBar {
  t: number;
  bought: number; // shares the aggressor bought (of this side)
  sold: number; // shares the aggressor sold (bought the other side)
}

/** Aggressive buying vs selling of the viewed side per bucket. */
export function flow(trades: TradeTick[], bucketMs: number): FlowBar[] {
  const by = new Map<number, FlowBar>();
  for (const x of trades) {
    const b = Math.floor(x.t / bucketMs) * bucketMs;
    const f = by.get(b) ?? { t: b, bought: 0, sold: 0 };
    if (x.takerBought) f.bought += x.qty;
    else f.sold += x.qty;
    by.set(b, f);
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/** Index of the last element with t ≤ at (−1 if none). */
export function lastAt<T extends { t: number }>(xs: T[], at: number): number {
  let lo = 0, hi = xs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid].t <= at) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
