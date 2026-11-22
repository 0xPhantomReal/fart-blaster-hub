// Bitcoin order flow, live over public websockets, for the pump bot's flip signals:
//   Coinbase spot BTC-USD — best bid/ask with sizes ("ticker") and every trade ("matches")
//   Hyperliquid BTC perpetual — the order book ("l2Book") and every trade ("trades")
// From these: order-flow imbalance (Cont–Kukanov–Stoikov OFI at the top of the book), microprice offset, top-of-book
// imbalance, aggressive buy/sell volume, and each venue's price versus BRTI (lead–lag). Either feed may fail; its
// fields are then null. URLs can be overridden for tests (BTCFLOW_CB_URL / BTCFLOW_HL_URL).

export interface Top {
  at: number; // ms
  bid: number;
  bidSz: number;
  ask: number;
  askSz: number;
}
interface FlowTrade {
  at: number;
  sz: number; // BTC
  buy: boolean; // aggressor bought
  px: number;
}

/** One venue: the latest top of book, recent OFI increments, trades and mids. */
export class Venue {
  top: Top | null = null;
  ofi: { at: number; e: number }[] = [];
  trades: FlowTrade[] = [];
  mids: { at: number; mid: number }[] = [];
  depth: { bid: number; ask: number } | null = null; // size within 10 bps (book venues only)
  msgs = 0;
  constructor(readonly name: string, private readonly now: () => number = Date.now) {}

  /** A new top of book: add the OFI increment (Cont et al. 2014). */
  setTop(t: Omit<Top, "at">) {
    const at = this.now();
    const p = this.top;
    if (p) {
      const e = (t.bid >= p.bid ? t.bidSz : 0) - (t.bid <= p.bid ? p.bidSz : 0) - (t.ask <= p.ask ? t.askSz : 0) +
        (t.ask >= p.ask ? p.askSz : 0);
      if (e !== 0) this.ofi.push({ at, e });
    }
    this.top = { at, ...t };
    const mid = (t.bid + t.ask) / 2;
    const last = this.mids[this.mids.length - 1];
    if (!last || at - last.at >= 250) this.mids.push({ at, mid });
    this.msgs++;
    this.trim(at);
  }

  addTrade(x: Omit<FlowTrade, "at">) {
    const at = this.now();
    this.trades.push({ at, ...x });
    this.msgs++;
    this.trim(at);
  }

  private trim(at: number) {
    const cut = at - 120_000;
    for (const xs of [this.ofi, this.trades, this.mids] as { at: number }[][]) {
      while (xs.length && xs[0].at < cut) xs.shift();
    }
  }

  /** Numbers for "now", from the last `s` seconds (+ = toward Up / buying). */
  stats(nowMs: number) {
    const t = this.top;
    if (!t || nowMs - t.at > 10_000) return null;
    const mid = (t.bid + t.ask) / 2;
    const micro = (t.bid * t.askSz + t.ask * t.bidSz) / (t.bidSz + t.askSz || 1);
    const sum = (xs: { at: number }[], s: number, f: (x: never) => number) =>
      xs.filter((x) => x.at >= nowMs - s * 1000).reduce((a, x) => a + f(x as never), 0);
    const flow = (s: number) => {
      const buy = sum(this.trades, s, (x: FlowTrade) => (x.buy ? x.sz : 0));
      const sell = sum(this.trades, s, (x: FlowTrade) => (x.buy ? 0 : x.sz));
      return { buy: r3(buy), sell: r3(sell), net: r3(buy - sell) };
    };
    const midAgo = (s: number) => {
      let v: number | null = null;
      for (const m of this.mids) {
        if (m.at > nowMs - s * 1000) break;
        v = m.mid;
      }
      return v === null ? null : r2(mid - v);
    };
    return {
      mid: r2(mid),
      spread: r2(t.ask - t.bid),
      micro_minus_mid: r2(micro - mid),
      top_imbalance: r2((t.bidSz - t.askSz) / (t.bidSz + t.askSz || 1)),
      depth10bps_imbalance: this.depth && this.depth.bid + this.depth.ask > 0
        ? r2((this.depth.bid - this.depth.ask) / (this.depth.bid + this.depth.ask))
        : null,
      ofi_5s: r3(sum(this.ofi, 5, (x: { e: number }) => x.e)),
      ofi_15s: r3(sum(this.ofi, 15, (x: { e: number }) => x.e)),
      flow_5s: flow(5),
      flow_15s: flow(15),
      flow_60s: flow(60),
      move_5s: midAgo(5),
      move_15s: midAgo(15),
      age_ms: nowMs - t.at,
    };
  }
}
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Coinbase Exchange feed messages. Matches report the MAKER's side: a "sell" maker means the taker bought. */
export function takeCoinbase(v: Venue, m: Record<string, unknown>) {
  if (m.type === "ticker") {
    const bid = Number(m.best_bid), ask = Number(m.best_ask);
    const bidSz = Number(m.best_bid_size ?? 0), askSz = Number(m.best_ask_size ?? 0);
    if (bid > 0 && ask > 0) v.setTop({ bid, ask, bidSz, askSz });
  } else if (m.type === "match" || m.type === "last_match") {
    const sz = Number(m.size), px = Number(m.price);
    if (sz > 0 && px > 0) v.addTrade({ sz, px, buy: m.side === "sell" });
  }
}

/** Hyperliquid messages: l2Book levels [bids, asks] of {px, sz}; trades side "B" = aggressor bought. */
export function takeHyperliquid(v: Venue, m: Record<string, unknown>) {
  // deno-lint-ignore no-explicit-any
  const d = m.data as any;
  if (m.channel === "l2Book" && d?.levels) {
    const lv = (xs: { px: string; sz: string }[]) => (xs ?? []).map((x) => [Number(x.px), Number(x.sz)] as [number, number]);
    const bids = lv(d.levels[0]), asks = lv(d.levels[1]);
    if (!bids.length || !asks.length) return;
    const mid = (bids[0][0] + asks[0][0]) / 2;
    v.depth = {
      bid: bids.filter(([p]) => p >= mid * (1 - 0.001)).reduce((a, [, q]) => a + q, 0),
      ask: asks.filter(([p]) => p <= mid * (1 + 0.001)).reduce((a, [, q]) => a + q, 0),
    };
    v.setTop({ bid: bids[0][0], bidSz: bids[0][1], ask: asks[0][0], askSz: asks[0][1] });
  } else if (m.channel === "trades" && Array.isArray(d)) {
    for (const t of d) {
      const sz = Number(t.sz), px = Number(t.px);
      if (sz > 0 && px > 0) v.addTrade({ sz, px, buy: t.side === "B" });
    }
  }
}

/** Both feeds over websockets for the length of one run. */
export class BtcFlow {
  cb = new Venue("coinbase");
  hl = new Venue("hyperliquid");
  private socks: WebSocket[] = [];
  errors: string[] = [];

  start() {
    // deno-lint-ignore no-explicit-any
    const env = (k: string): string => (globalThis as any).Deno?.env?.get(k) ?? "";
    this.open(env("BTCFLOW_CB_URL") || "wss://ws-feed.exchange.coinbase.com", (ws) =>
      ws.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker", "matches"] })), (m) =>
      takeCoinbase(this.cb, m));
    this.open(env("BTCFLOW_HL_URL") || "wss://api.hyperliquid.xyz/ws", (ws) => {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: "BTC" } }));
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: "BTC" } }));
    }, (m) => takeHyperliquid(this.hl, m));
  }

  private open(url: string, onOpen: (ws: WebSocket) => void, onMsg: (m: Record<string, unknown>) => void) {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => onOpen(ws);
      ws.onmessage = (e) => {
        try {
          onMsg(JSON.parse(typeof e.data === "string" ? e.data : ""));
        } catch { /* skip */ }
      };
      ws.onerror = () => this.errors.push(url);
      this.socks.push(ws);
    } catch (e) {
      this.errors.push(`${url}: ${(e as Error).message}`);
    }
  }

  close() {
    for (const s of this.socks) {
      try {
        s.close();
      } catch { /* closed */ }
    }
  }

  /** Both venues' numbers, plus each venue's price minus BRTI (does the exchange lead?). */
  snapshot(nowMs: number, brti: number | null) {
    const cb = this.cb.stats(nowMs), hl = this.hl.stats(nowMs);
    return {
      coinbase: cb,
      hyperliquid: hl,
      coinbase_minus_brti: cb && brti ? r2(cb.mid - brti) : null,
      hyperliquid_minus_brti: hl && brti ? r2(hl.mid - brti) : null,
    };
  }
}
export type BtcFlowSnap = ReturnType<BtcFlow["snapshot"]>;
