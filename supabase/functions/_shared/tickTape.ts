// Jerico: every tick of the 5-minute BTC Up/Down market on Polymarket US, from the markets websocket.
// A tick is a change in the top of the book (best bid/ask and their sizes) or a trade. Prices are YES prices (the
// page turns them into Up/Down using which side YES pays on). Ticks are batched into small chunks (one database row
// every few seconds) so recording every tick stays light on the database.
//
// Chunk rows, times in ms after the chunk's t0:
//   [dt, 0, bid, bidSize, ask, askSize]   top of book changed
//   [dt, 1, price, quantity, takerBoughtYes (1/0)]   a trade

export type TickRow = number[];

const num = (x: unknown): number | null => {
  const v = typeof x === "object" && x !== null ? (x as { value?: unknown }).value : x;
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isFinite(n) ? n : null;
};

export class TickRecorder {
  private rows: [number, ...number[]][] = [];
  private last: [number, number, number, number] | null = null;
  private fullBook = false;
  ticks = 0;
  trades = 0;
  constructor(readonly slug: string, private readonly now: () => number = Date.now) {}

  /** A top-of-book state; recorded only when something changed. */
  book(bid: number, bidSz: number, ask: number, askSz: number) {
    const b: [number, number, number, number] = [r4(bid), Math.round(bidSz), r4(ask), Math.round(askSz)];
    const l = this.last;
    if (l && l[0] === b[0] && l[1] === b[1] && l[2] === b[2] && l[3] === b[3]) return;
    this.last = b;
    this.rows.push([this.now(), 0, ...b]);
    this.ticks++;
  }

  trade(px: number, qty: number, takerBoughtYes: boolean) {
    this.rows.push([this.now(), 1, r4(px), Math.round(qty * 100) / 100, takerBoughtYes ? 1 : 0]);
    this.trades++;
  }

  /** Full-book websocket message (marketData). */
  takeBook(d: Record<string, unknown> | undefined) {
    if (!d || (d.marketSlug && d.marketSlug !== this.slug)) return;
    // deno-lint-ignore no-explicit-any
    const lv = (xs: any) =>
      (Array.isArray(xs) ? xs : [])
        .map((l) => [num(l?.px ?? l?.price), Number(l?.qty ?? l?.quantity ?? 0)] as [number | null, number])
        .filter((l): l is [number, number] => l[0] !== null && l[0] > 0 && l[0] < 1 && l[1] > 0);
    const bids = lv(d.bids), offers = lv(d.offers ?? d.asks);
    if (!bids.length || !offers.length) return;
    const bb = bids.reduce((a, x) => (x[0] > a[0] ? x : a));
    const ba = offers.reduce((a, x) => (x[0] < a[0] ? x : a));
    this.fullBook = true;
    this.book(bb[0], bb[1], ba[0], ba[1]);
  }

  /** Best bid/ask message (marketDataLite): only until full books arrive (it has no sizes). */
  takeLite(d: Record<string, unknown> | undefined) {
    if (!d || (d.marketSlug && d.marketSlug !== this.slug) || this.fullBook) return;
    const bid = num(d.bestBid), ask = num(d.bestAsk);
    if (bid !== null && ask !== null) this.book(bid, 0, ask, 0);
  }

  /** Trade message. Taker intents BUY_LONG / SELL_SHORT take YES; BUY_SHORT / SELL_LONG take NO. */
  takeTrade(d: Record<string, unknown> | undefined) {
    if (!d || (d.marketSlug && d.marketSlug !== this.slug)) return;
    const px = num(d.price), qty = num(d.quantity);
    if (px === null || qty === null || !(qty > 0)) return;
    // deno-lint-ignore no-explicit-any
    const intent = String((d.taker as any)?.intent ?? "");
    const yes = /BUY_LONG|SELL_SHORT/.test(intent) ? true : /BUY_SHORT|SELL_LONG/.test(intent) ? false : null;
    if (yes === null) return;
    this.trade(px, qty, yes);
  }

  /** Everything since the last call, as one chunk (null if nothing new). */
  flush(): { t0: number; rows: TickRow[] } | null {
    if (!this.rows.length) return null;
    const t0 = this.rows[0][0];
    const rows = this.rows.map(([t, ...rest]) => [t - t0, ...rest]);
    this.rows = [];
    return { t0, rows };
  }
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
