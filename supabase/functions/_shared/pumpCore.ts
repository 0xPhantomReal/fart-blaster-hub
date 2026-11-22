// Pump bot (fadebot action "pump"): buy a cheap side (ask under PUMP_MAX_ASK, 30¢) of Polymarket US's 5-minute BTC
// Up/Down market when Jev thinks the order book, trade flow, volatility and time left can carry it to +100%, then
// sell at +100% (take profit), −50% (stop loss) or a few seconds before the window ends.
//
// Everything comes over the Polymarket US markets websocket: the full order book (market data), every trade, and the
// best bid/ask. This file is the pure part (no network, no database) so it can be tested.

export type Side = "up" | "down";
/** [price, shares] in OUR side's prices (0–1). */
export type Level = [number, number];
export interface SideBook {
  bids: Level[]; // best (highest) first
  asks: Level[]; // best (lowest) first
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const num = (x: unknown): number | null => {
  const v = typeof x === "object" && x !== null ? (x as { value?: unknown }).value : x;
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isFinite(n) ? n : null;
};

/**
 * Both sides' books from the YES book. The YES side buys from YES offers and sells into YES bids. The NO side's
 * ask is 1 − the YES bid (buying NO = selling YES) and its bid is 1 − the YES ask.
 */
export function sideBooks(yesBids: Level[], yesOffers: Level[], longIs: Side): Record<Side, SideBook> {
  const desc = (a: Level, b: Level) => b[0] - a[0];
  const asc = (a: Level, b: Level) => a[0] - b[0];
  const yes: SideBook = { bids: [...yesBids].sort(desc), asks: [...yesOffers].sort(asc) };
  const no: SideBook = {
    bids: yesOffers.map(([p, q]) => [r4(1 - p), q] as Level).sort(desc),
    asks: yesBids.map(([p, q]) => [r4(1 - p), q] as Level).sort(asc),
  };
  return longIs === "up" ? { up: yes, down: no } : { up: no, down: yes };
}

/** Buying `dollars` against `asks`: shares and the average price (null if the book can't fill it). */
export function walkBuy(asks: Level[], dollars: number): { shares: number; price: number } | null {
  let left = dollars, shares = 0;
  for (const [p, q] of asks) {
    if (!(p > 0)) continue;
    const take = Math.min(q, left / p);
    shares += take;
    left -= take * p;
    if (left <= 1e-9) break;
  }
  return left > 1e-6 || !shares ? null : { shares, price: dollars / shares };
}

/** Selling `shares` into `bids`: proceeds and the average price (what fills; unfilled shares are left over). */
export function walkSell(bids: Level[], shares: number): { sold: number; proceeds: number; price: number } {
  let left = shares, proceeds = 0;
  for (const [p, q] of bids) {
    const take = Math.min(q, left);
    proceeds += take * p;
    left -= take;
    if (left <= 1e-9) break;
  }
  const sold = shares - Math.max(0, left);
  return { sold, proceeds, price: sold > 0 ? proceeds / sold : 0 };
}

/** Polymarket US taker fee per share (0.095 × p × (1 − p)). */
export const feePerShare = (p: number, rate = 0.095) => rate * p * (1 - p);

export interface TapeTrade {
  at: number; // ms
  yesPx: number;
  qty: number;
  /** Which side the TAKER bought ("up"/"down"), i.e. who was aggressive. */
  takerBought: Side;
}
export interface TapePoint {
  at: number; // ms
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
  /** Shares bid within 5¢ of the best bid, per side (for "bids stacking"). */
  upBidDepth?: number;
  downBidDepth?: number;
}

/** The market as the websocket pushes it: latest full book, recent trades, and a price history. */
export class MarketTape {
  yesBids: Level[] = [];
  yesOffers: Level[] = [];
  bookAt = 0;
  lastTradeYes: number | null = null;
  trades: TapeTrade[] = [];
  hist: TapePoint[] = [];
  updates = 0;
  constructor(readonly slug: string, readonly longIs: Side, private readonly now: () => number = Date.now) {}

  books(): Record<Side, SideBook> {
    return sideBooks(this.yesBids, this.yesOffers, this.longIs);
  }

  /** A full-book message (marketData). */
  takeBook(d: Record<string, unknown> | undefined) {
    if (!d || (d.marketSlug && d.marketSlug !== this.slug)) return;
    // deno-lint-ignore no-explicit-any
    const lv = (xs: any): Level[] =>
      (Array.isArray(xs) ? xs : [])
        .map((l) => [num(l?.px ?? l?.price), Number(l?.qty ?? l?.quantity ?? 0)] as [number | null, number])
        .filter((l): l is Level => l[0] !== null && l[0] > 0 && l[0] < 1 && Number.isFinite(l[1]) && l[1] > 0);
    this.yesBids = lv(d.bids);
    this.yesOffers = lv(d.offers ?? d.asks);
    this.bookAt = this.now();
    // deno-lint-ignore no-explicit-any
    const st = d.stats as any;
    const lt = num(st?.lastTradePx);
    if (lt !== null) this.lastTradeYes = lt;
    this.updates++;
    this.point();
  }

  /** A best bid/ask message (marketDataLite): only used until the first full book arrives. */
  takeLite(d: Record<string, unknown> | undefined) {
    if (!d || (d.marketSlug && d.marketSlug !== this.slug) || this.bookAt) return;
    const bid = num(d.bestBid), ask = num(d.bestAsk);
    if (bid !== null) this.yesBids = [[bid, 1e9]];
    if (ask !== null) this.yesOffers = [[ask, 1e9]];
    this.updates++;
    this.point();
  }

  /** A trade message. Intents: BUY_LONG / SELL_SHORT take YES; BUY_SHORT / SELL_LONG take NO. */
  takeTrade(d: Record<string, unknown> | undefined) {
    if (!d || (d.marketSlug && d.marketSlug !== this.slug)) return;
    const px = num(d.price), qty = num(d.quantity);
    if (px === null || qty === null || !(qty > 0)) return;
    // deno-lint-ignore no-explicit-any
    const intent = String((d.taker as any)?.intent ?? "");
    const tookYes = /BUY_LONG|SELL_SHORT/.test(intent) ? true : /BUY_SHORT|SELL_LONG/.test(intent) ? false : null;
    if (tookYes === null) return;
    const no: Side = this.longIs === "up" ? "down" : "up";
    this.trades.push({ at: this.now(), yesPx: px, qty, takerBought: tookYes ? this.longIs : no });
    this.lastTradeYes = px;
    const cut = this.now() - 180_000;
    while (this.trades.length && this.trades[0].at < cut) this.trades.shift();
    this.updates++;
  }

  private point() {
    const b = this.books();
    const depth = (bk: SideBook) => {
      const top = bk.bids[0]?.[0];
      return top === undefined ? 0 : Math.round(bk.bids.filter(([p]) => p >= top - 0.05 - 1e-9).reduce((a, [, q]) => a + q, 0));
    };
    const p: TapePoint = {
      at: this.now(),
      upAsk: b.up.asks[0]?.[0] ?? null,
      upBid: b.up.bids[0]?.[0] ?? null,
      downAsk: b.down.asks[0]?.[0] ?? null,
      downBid: b.down.bids[0]?.[0] ?? null,
      upBidDepth: depth(b.up),
      downBidDepth: depth(b.down),
    };
    const last = this.hist[this.hist.length - 1];
    const samePx = last && last.upAsk === p.upAsk && last.upBid === p.upBid && last.downAsk === p.downAsk &&
      last.downBid === p.downBid;
    // A new point when a price changes, or depth changes (at most 4 a second).
    if (last && samePx && (p.at - last.at < 250 || (last.upBidDepth === p.upBidDepth && last.downBidDepth === p.downBidDepth))) {
      return;
    }
    this.hist.push(p);
    const cut = this.now() - 180_000;
    while (this.hist.length && this.hist[0].at < cut) this.hist.shift();
  }
}

export interface BtcCtx {
  price: number | null;
  /** The window's price to beat (BRTI average of the minute before it), when known. */
  ref: number | null;
  /** Recent BRTI ticks: [unix seconds, price]. */
  ticks: [number, number][];
}

/** Realised volatility in $ per √second from ticks over the last `sec` seconds (1-second buckets). */
export function btcVolPerSec(ticks: [number, number][], nowSec: number, sec: number): number | null {
  const by = new Map<number, number>();
  for (const [t, p] of ticks) if (t >= nowSec - sec && t <= nowSec) by.set(Math.floor(t), p);
  const ks = [...by.keys()].sort((a, b) => a - b);
  if (ks.length < 10) return null;
  let s = 0, n = 0;
  for (let i = 1; i < ks.length; i++) {
    const dt = ks[i] - ks[i - 1];
    const d = by.get(ks[i])! - by.get(ks[i - 1])!;
    s += (d * d) / dt;
    n++;
  }
  return n ? Math.sqrt(s / n) : null;
}

/** What Jev (and the log) sees about one side right now. */
export function pumpFeatures(tape: MarketTape, side: Side, secondsLeft: number, btc: BtcCtx, nowMs = Date.now()) {
  const b = tape.books()[side];
  const ask = b.asks[0]?.[0] ?? null, bid = b.bids[0]?.[0] ?? null;
  const within = (lv: Level[], from: number, to: number) => {
    let sh = 0, usd = 0;
    for (const [p, q] of lv) {
      if (p >= Math.min(from, to) - 1e-9 && p <= Math.max(from, to) + 1e-9) {
        sh += q;
        usd += p * q;
      }
    }
    return { shares: Math.round(sh), usd: r2(usd) };
  };
  const askDepth5 = ask === null ? null : within(b.asks, ask, ask + 0.05);
  const bidDepth5 = bid === null ? null : within(b.bids, bid - 0.05, bid);
  // How much buying it takes to lift the ask to 2× (offers between the ask and 2× the ask).
  const to2x = ask === null ? null : within(b.asks, ask, Math.min(0.99, ask * 2));
  const flow = (sec: number) => {
    const cut = nowMs - sec * 1000;
    let buy = 0, sell = 0, n = 0;
    for (const t of tape.trades) {
      if (t.at < cut) continue;
      n++;
      if (t.takerBought === side) buy += t.qty;
      else sell += t.qty;
    }
    return { trades: n, buy_shares: Math.round(buy), sell_shares: Math.round(sell), net: Math.round(buy - sell) };
  };
  const askKey = side === "up" ? "upAsk" : "downAsk";
  const asks = (sec: number) =>
    tape.hist.filter((p) => p.at >= nowMs - sec * 1000 && p[askKey] !== null).map((p) => p[askKey] as number);
  const moves = (sec: number) => {
    const xs = asks(sec);
    if (!xs.length) return null;
    let changes = 0, absMove = 0;
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] !== xs[i - 1]) changes++;
      absMove += Math.abs(xs[i] - xs[i - 1]);
    }
    return {
      first_c: Math.round(xs[0] * 100),
      low_c: Math.round(Math.min(...xs) * 100),
      high_c: Math.round(Math.max(...xs) * 100),
      changes,
      total_move_c: Math.round(absMove * 100),
    };
  };
  // A 1-per-second trace of this side's ask over the last 60 s, oldest first (cents).
  const trace: (number | null)[] = [];
  for (let s = 60; s >= 0; s -= 2) {
    const t = nowMs - s * 1000;
    let v: number | null = null;
    for (const p of tape.hist) {
      if (p.at > t) break;
      v = p[askKey];
    }
    trace.push(v === null ? null : Math.round(v * 100));
  }
  const nowSec = nowMs / 1000;
  const vol60 = btcVolPerSec(btc.ticks, nowSec, 60);
  const vol20 = btcVolPerSec(btc.ticks, nowSec, 20);
  const move = (sec: number) => {
    const old = btc.ticks.find(([t]) => t >= nowSec - sec);
    return old && btc.price !== null ? r2(btc.price - old[1]) : null;
  };
  const dist = btc.price !== null && btc.ref !== null ? r2(btc.price - btc.ref) : null;
  // Our side needs BTC to move toward it: Up wants BTC above the ref, Down below. "away" > 0 = losing side.
  const away = dist === null ? null : side === "up" ? -dist : dist;
  return {
    side,
    seconds_left: Math.round(secondsLeft),
    ask_c: ask === null ? null : Math.round(ask * 1000) / 10,
    bid_c: bid === null ? null : Math.round(bid * 1000) / 10,
    spread_c: ask !== null && bid !== null ? Math.round((ask - bid) * 1000) / 10 : null,
    target_bid_c: ask === null ? null : Math.round(Math.min(0.99, ask * 2) * 1000) / 10,
    stop_bid_c: ask === null ? null : Math.round(ask * 0.5 * 1000) / 10,
    book: {
      ask_depth_5c: askDepth5,
      bid_depth_5c: bidDepth5,
      offers_up_to_2x: to2x,
      imbalance_bid_share:
        askDepth5 && bidDepth5 && askDepth5.shares + bidDepth5.shares > 0
          ? r2(bidDepth5.shares / (askDepth5.shares + bidDepth5.shares))
          : null,
      // This side's book, best first: [price ¢, shares].
      bids_top10: b.bids.slice(0, 10).map(([p, q]) => [Math.round(p * 1000) / 10, Math.round(q)]),
      asks_top10: b.asks.slice(0, 10).map(([p, q]) => [Math.round(p * 1000) / 10, Math.round(q)]),
      book_age_ms: tape.bookAt ? nowMs - tape.bookAt : null,
    },
    flow_10s: flow(10),
    flow_30s: flow(30),
    flow_60s: flow(60),
    price_moves_30s: moves(30),
    price_moves_60s: moves(60),
    ask_trace_60s_every_2s_c: trace,
    btc: {
      price: btc.price === null ? null : r2(btc.price),
      price_to_beat: btc.ref === null ? null : r2(btc.ref),
      vs_price_to_beat: dist,
      dollars_against_this_side: away,
      move_10s: move(10),
      move_30s: move(30),
      move_60s: move(60),
      vol_per_sqrt_sec_20s: vol20 === null ? null : r2(vol20),
      vol_per_sqrt_sec_60s: vol60 === null ? null : r2(vol60),
      // How many "typical moves over the time left" BTC is from flipping to this side (smaller = more reachable).
      sigmas_to_flip:
        away !== null && vol60 && secondsLeft > 0 ? r2(Math.max(0, away) / (vol60 * Math.sqrt(secondsLeft))) : null,
    },
  };
}
export type PumpFeatures = ReturnType<typeof pumpFeatures>;

export interface PumpCfg {
  maxAsk: number; //  buy only under this (0.30)
  minAsk: number; //  …and at or above this (0.02)
  tp: number; //      take profit, fraction of the entry price (1 = +100%)
  sl: number; //      stop loss, fraction (0.5 = −50%)
  exitSec: number; // sell when this many seconds are left
  minLeft: number; // no new buys with fewer seconds left
}

/** The side to ask Jev about: the cheapest side whose ask is in [minAsk, maxAsk), or null. */
export function pumpCandidate(books: Record<Side, SideBook>, cfg: PumpCfg): { side: Side; ask: number } | null {
  let best: { side: Side; ask: number } | null = null;
  for (const side of ["up", "down"] as Side[]) {
    const ask = books[side].asks[0]?.[0];
    if (ask === undefined || ask < cfg.minAsk - 1e-9 || ask >= cfg.maxAsk - 1e-9) continue;
    if (!best || ask < best.ask) best = { side, ask };
  }
  return best;
}

/** Whether to sell now, measured on the side's BID (what it sells for) against the price paid. */
export function pumpExit(entry: number, bid: number | null, secondsLeft: number, cfg: PumpCfg):
  | "take profit"
  | "stop loss"
  | "time"
  | null {
  if (bid !== null && bid >= entry * (1 + cfg.tp) - 1e-9) return "take profit";
  if (bid !== null && bid <= entry * (1 - cfg.sl) + 1e-9) return "stop loss";
  if (cfg.exitSec > 0 && secondsLeft <= cfg.exitSec) return "time";
  return null;
}

export interface ScoreCfg {
  /** Offers between the ask and 2× (in $): at or under `thinLo` scores full points, at or over `thinHi` none. */
  thinLo: number;
  thinHi: number;
}
export const DEFAULT_SCORE_CFG: ScoreCfg = { thinLo: 20, thinHi: 300 };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The bot's own read of the microstructure for one side: five signals, 20 points each (0–100).
 *  flow   — aggressive buying of this side in the last 10 s (share of taker volume) and whether it's speeding up
 *  thin   — few dollars of offers between the ask and 2× (a small wave of buying lifts it)
 *  bids   — bid depth outweighing ask depth near the touch, and bid depth growing over the last 20 s
 *  turn   — the ask lifting off its 30 s low, and a higher low (last 10 s low above the 10–30 s low)
 *  btc    — bitcoin close enough to flip to this side for its volatility and the time left, and moving toward it
 */
export function pumpScore(f: PumpFeatures, tape: MarketTape, nowMs: number, cfg: ScoreCfg = DEFAULT_SCORE_CFG) {
  const side = f.side;
  const notes: string[] = [];
  // flow
  const f10 = f.flow_10s, f60 = f.flow_60s;
  let flow = 0;
  if (f10.trades > 0 && f10.buy_shares + f10.sell_shares > 0) {
    const share = f10.buy_shares / (f10.buy_shares + f10.sell_shares);
    const rate10 = f10.buy_shares / 10, rate60 = f60.buy_shares / 60;
    const accel = rate60 > 0 ? clamp01((rate10 / rate60 - 1) / 2) : f10.buy_shares > 0 ? 1 : 0;
    flow = clamp01((share - 0.5) / 0.4) * 10 + (share > 0.5 ? accel * 10 : 0);
    notes.push(`buyers ${Math.round(share * 100)}% of the last 10 s${accel > 0 && share > 0.5 ? `, ${(rate60 > 0 ? rate10 / rate60 : 9).toFixed(1)}× the 60 s pace` : ""}`);
  } else notes.push("no trades in the last 10 s");
  // thin offers above
  let thin = 0;
  const usd = f.book.offers_up_to_2x?.usd ?? null;
  if (usd !== null) {
    thin = 20 * clamp01((Math.log(cfg.thinHi) - Math.log(Math.max(usd, 0.01))) / (Math.log(cfg.thinHi) - Math.log(cfg.thinLo)));
    notes.push(`$${usd} of offers up to 2×`);
  }
  // bids stacking
  let bids = 0;
  const imb = f.book.imbalance_bid_share;
  if (imb !== null) bids += 14 * clamp01((imb - 0.5) / 0.3);
  const key = side === "up" ? "upBidDepth" : "downBidDepth";
  const nowD = tape.hist.length ? tape.hist[tape.hist.length - 1][key] ?? null : null;
  let then: number | null = null;
  for (const p of tape.hist) {
    if (p.at > nowMs - 20_000) break;
    then = p[key] ?? null;
  }
  if (nowD !== null && then !== null && then > 0 && nowD >= then * 1.3) {
    bids += 6;
    notes.push(`bid depth up ${Math.round((nowD / then - 1) * 100)}% in 20 s`);
  }
  if (imb !== null) notes.push(`bids ${Math.round(imb * 100)}% of depth near the touch`);
  // price turning up
  let turn = 0;
  const askKey = side === "up" ? "upAsk" : "downAsk";
  const win = (a: number, b: number) =>
    tape.hist.filter((p) => p.at >= nowMs - a * 1000 && p.at < nowMs - b * 1000 && p[askKey] !== null).map((p) => p[askKey] as number);
  const last30 = win(30, -1), last10 = win(10, -1), prior = win(30, 10);
  const ask = f.ask_c === null ? null : f.ask_c / 100;
  if (ask !== null && last30.length) {
    const low = Math.min(...last30);
    if (ask > low + 1e-9) {
      turn += 10 * clamp01((ask / low - 1) / 0.2);
      notes.push(`ask ${Math.round((ask / low - 1) * 100)}% off its 30 s low`);
    }
    if (last10.length && prior.length && Math.min(...last10) > Math.min(...prior) + 1e-9) {
      turn += 10;
      notes.push("higher low");
    }
  }
  // bitcoin
  let btc = 0;
  const sig = f.btc.sigmas_to_flip;
  if (sig !== null) {
    btc += 12 * clamp01((2 - sig) / 1.5);
    notes.push(`BTC ${sig} typical moves from flipping`);
  }
  const vol = f.btc.vol_per_sqrt_sec_20s ?? f.btc.vol_per_sqrt_sec_60s;
  const m10 = f.btc.move_10s;
  if (m10 !== null && vol) {
    const toward = side === "up" ? m10 : -m10;
    if (toward > 0) {
      btc += 8 * clamp01(toward / (vol * Math.sqrt(10)));
      notes.push(`BTC moved $${Math.abs(m10)} toward ${side} in 10 s`);
    }
  }
  const parts = { flow: Math.round(flow), thin: Math.round(thin), bids: Math.round(bids), turn: Math.round(turn), btc: Math.round(btc) };
  const score = parts.flow + parts.thin + parts.bids + parts.turn + parts.btc;
  return { score, parts, notes };
}
export type PumpScore = ReturnType<typeof pumpScore>;

const Phi = (x: number) => {
  // Normal CDF (Abramowitz–Stegun 7.1.26 via erf)
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-(x * x) / 2);
  return 0.5 * (1 + (x >= 0 ? y : -y));
};

/**
 * Fair chance this side wins from bitcoin alone: its distance from the price to beat against its volatility over the
 * time left. Settlement averages BRTI over the last minute, so the effective time shrinks by ~40 s before the last
 * minute; inside it, the part of the average already locked in is accounted for.
 */
export function fairChance(
  side: Side,
  btc: number,
  ref: number,
  volPerSqrtSec: number,
  secondsLeft: number,
  lastMinute: { sum: number; n: number } | null,
) {
  const dir = side === "up" ? 1 : -1;
  if (!(volPerSqrtSec > 0)) return null;
  if (secondsLeft > 60 || !lastMinute || !lastMinute.n) {
    const teff = Math.max(secondsLeft - 40, 5);
    return Phi((dir * (btc - ref)) / (volPerSqrtSec * Math.sqrt(teff)));
  }
  // In the last minute: final average = (locked sum + sum of the rest) / total. The rest averages ~btc with
  // st. dev. vol·√(left/3) (an average of a random walk).
  const left = Math.max(secondsLeft, 1);
  const total = lastMinute.n + left;
  const need = (ref * total - lastMinute.sum) / left; // the rest must average this for a tie
  const sd = volPerSqrtSec * Math.sqrt(left / 3);
  return Phi((dir * (btc - need)) / Math.max(sd, 0.01));
}

/** Everything about one side at one second, for the recorder (and the flip-signal search later). */
export function snapRow(
  tape: MarketTape,
  side: Side,
  secondsLeft: number,
  btc: BtcCtx,
  windowEnd: number,
  flowSnap: Record<string, unknown> | null,
  nowMs = Date.now(),
) {
  const b = tape.books()[side];
  const ask = b.asks[0]?.[0] ?? null, bid = b.bids[0]?.[0] ?? null;
  const askSz = b.asks[0]?.[1] ?? 0, bidSz = b.bids[0]?.[1] ?? 0;
  const fill = (usd: number) => {
    const w = walkBuy(b.asks, usd);
    return w ? Math.round(w.price * 10000) / 10000 : null;
  };
  const depthAt = (lv: Level[], top: number | undefined, dir: 1 | -1) =>
    top === undefined ? 0 : lv.filter(([p]) => (dir > 0 ? p <= top + 0.05 + 1e-9 : p >= top - 0.05 - 1e-9))
      .reduce((a, [, q]) => a + q, 0);
  const nowSec = nowMs / 1000;
  const vol10 = btcVolPerSec(btc.ticks, nowSec, 10), vol60 = btcVolPerSec(btc.ticks, nowSec, 60);
  const dir = side === "up" ? 1 : -1;
  const btcAgo = (s: number) => {
    const old = btc.ticks.find(([t]) => t >= nowSec - s);
    return old && btc.price !== null ? Math.round(dir * (btc.price - old[1]) * 100) / 100 : null;
  };
  const lm = btc.ticks.filter(([t]) => t >= windowEnd - 60 && t <= nowSec);
  const lastMinute = secondsLeft <= 60 && lm.length ? { sum: lm.reduce((a, [, p]) => a + p, 0), n: lm.length } : null;
  const vol = vol60 ?? vol10;
  const fair = btc.price !== null && btc.ref !== null && vol
    ? fairChance(side, btc.price, btc.ref, vol, secondsLeft, lastMinute)
    : null;
  const askKey = side === "up" ? "upAsk" : "downAsk";
  const depthKey = side === "up" ? "upBidDepth" : "downBidDepth";
  const at = (s: number) => {
    let v: TapePoint | null = null;
    for (const p of tape.hist) {
      if (p.at > nowMs - s * 1000) break;
      v = p;
    }
    return v;
  };
  const p5 = at(5), p30 = at(30);
  const flowS = (sec: number) => {
    let buy = 0, sell = 0;
    for (const t of tape.trades) {
      if (t.at < nowMs - sec * 1000) continue;
      if (t.takerBought === side) buy += t.qty;
      else sell += t.qty;
    }
    return Math.round(buy - sell);
  };
  const fill10 = fill(10), fill20 = fill(20);
  return {
    ask,
    bid,
    fill10,
    fill20,
    fair: fair === null ? null : Math.round(fair * 10000) / 10000,
    gap: fair !== null && fill10 !== null ? Math.round((fair - fill10) * 10000) / 10000 : null,
    features: {
      pm: {
        spread: ask !== null && bid !== null ? r4(ask - bid) : null,
        micro_minus_mid: ask !== null && bid !== null && askSz + bidSz > 0
          ? r4((bid * askSz + ask * bidSz) / (askSz + bidSz) - (ask + bid) / 2)
          : null,
        top_imbalance: askSz + bidSz > 0 ? r2((bidSz - askSz) / (bidSz + askSz)) : null,
        ask_depth5: Math.round(depthAt(b.asks, b.asks[0]?.[0], 1)),
        bid_depth5: Math.round(depthAt(b.bids, b.bids[0]?.[0], -1)),
        offers_to_2x_usd: ask === null ? null : r2(b.asks.filter(([p]) => p <= Math.min(0.99, ask * 2) + 1e-9)
          .reduce((a, [p, q]) => a + p * q, 0)),
        ask_chg_5s: ask !== null && p5?.[askKey] != null ? r4(ask - (p5[askKey] as number)) : null,
        ask_chg_30s: ask !== null && p30?.[askKey] != null ? r4(ask - (p30[askKey] as number)) : null,
        bid_depth_chg_5s: p5?.[depthKey] != null ? Math.round(depthAt(b.bids, b.bids[0]?.[0], -1) - (p5[depthKey] as number)) : null,
        taker_net_10s: flowS(10),
        taker_net_30s: flowS(30),
        book_age_ms: tape.bookAt ? nowMs - tape.bookAt : null,
      },
      btc: {
        price: btc.price,
        ref: btc.ref,
        toward: btc.price !== null && btc.ref !== null ? Math.round(dir * (btc.price - btc.ref) * 100) / 100 : null,
        vol10: vol10 === null ? null : r2(vol10),
        vol60: vol60 === null ? null : r2(vol60),
        move5: btcAgo(5),
        move10: btcAgo(10),
        move30: btcAgo(30),
        last_minute_locked: lastMinute ? lastMinute.n : 0,
      },
      // Coinbase spot + Hyperliquid perp order flow (+ = buying / toward UP; flip the sign for Down).
      flow: flowSnap,
    },
  };
}
export type SnapRow = ReturnType<typeof snapRow>;
