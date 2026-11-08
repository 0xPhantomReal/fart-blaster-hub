// Lightspeed V0.5 — the live market block, built server-side at the moment of each Jev call so the website and the
// Polymarket bot see the same thing (see docs/lightspeed-v0.5-research.md). Every source is public, has a short
// timeout, and is simply left out if it fails. Base URLs can be overridden (tests) with LS_*_URL secrets.

const env = (k: string) => Deno.env.get(k) ?? "";
const URLS = {
  coinbase: () => env("LS_COINBASE_URL") || "https://api.exchange.coinbase.com",
  kraken: () => env("LS_KRAKEN_URL") || "https://api.kraken.com",
  bitstamp: () => env("LS_BITSTAMP_URL") || "https://www.bitstamp.net",
  gemini: () => env("LS_GEMINI_URL") || "https://api.gemini.com",
  cryptocom: () => env("LS_CRYPTOCOM_URL") || "https://api.crypto.com",
  hyperliquid: () => env("LS_HYPERLIQUID_URL") || "https://api.hyperliquid.xyz",
  deribit: () => env("LS_DERIBIT_URL") || "https://www.deribit.com",
  polymarket: () => env("PM_GATEWAY_URL") || "https://gateway.polymarket.us",
};

const r = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const num = (v: unknown): number => {
  const x = typeof v === "object" && v !== null && "value" in (v as object) ? (v as { value: unknown }).value : v;
  return Number(x);
};

async function getJson(url: string, init?: RequestInit, ms = 2500): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { Accept: "application/json", "User-Agent": "lightspeed/0.5", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

type Level = [number, number]; // price, size

/** Order-book pressure: imbalance at the top and within 10/25 bps, micro-price offset, spread, depth. */
export function bookStats(bidsIn: Level[], asksIn: Level[]) {
  const bids = bidsIn.filter(([p, q]) => p > 0 && q > 0).sort((a, b) => b[0] - a[0]);
  const asks = asksIn.filter(([p, q]) => p > 0 && q > 0).sort((a, b) => a[0] - b[0]);
  if (!bids.length || !asks.length) return null;
  const [bp, bq] = bids[0];
  const [ap, aq] = asks[0];
  const mid = (bp + ap) / 2;
  const within = (bps: number) => {
    const lo = mid * (1 - bps / 1e4);
    const hi = mid * (1 + bps / 1e4);
    const b = bids.filter(([p]) => p >= lo).reduce((s, [, q]) => s + q, 0);
    const a = asks.filter(([p]) => p <= hi).reduce((s, [, q]) => s + q, 0);
    return { b, a, imb: b + a > 0 ? (b - a) / (b + a) : 0 };
  };
  const w10 = within(10);
  const w25 = within(25);
  const micro = (bp * aq + ap * bq) / (bq + aq);
  return {
    mid: r(mid),
    spread_bps: r(((ap - bp) / mid) * 1e4, 3),
    top_imbalance: r((bq - aq) / (bq + aq), 3),
    imbalance_within_10bps: r(w10.imb, 3),
    imbalance_within_25bps: r(w25.imb, 3),
    microprice_offset_bps: r(((micro - mid) / mid) * 1e4, 3),
    bid_depth_25bps: r(w25.b, 3),
    ask_depth_25bps: r(w25.a, 3),
  };
}

/** Aggressive flow over the last 10/30/60 s from the newest page of trades. */
export function tradeFlow(trades: { t: number; size: number; buy: boolean; price: number }[], now: number) {
  const win = (s: number) => {
    const w = trades.filter((x) => x.t >= now - s);
    const buy = w.filter((x) => x.buy).reduce((a, x) => a + x.size, 0);
    const sell = w.filter((x) => !x.buy).reduce((a, x) => a + x.size, 0);
    return {
      trades: w.length,
      buy_share_pct: buy + sell > 0 ? r((buy / (buy + sell)) * 100, 1) : null,
      net_aggressive_size: r(buy - sell, 4),
    };
  };
  const big = [...trades].filter((x) => x.t >= now - 60).sort((a, b) => b.size - a.size)[0];
  return {
    last_10s: win(10),
    last_30s: win(30),
    last_60s: win(60),
    largest_trade_last_60s: big ? { size: r(big.size, 4), side: big.buy ? "buy" : "sell", price: r(big.price) } : null,
  };
}

export interface LiveSpec {
  market: string; //            btc, eth, …
  coinbase?: string; //         e.g. BTC-USD
  tfSec: number;
  forTime: number; //           candle open time
  open: number | null; //       candle open price (for "move since open" of other assets: uses candles)
}

const SYM = (m: string) => m.toUpperCase();

async function coinbaseBook(product: string) {
  const j = (await getJson(`${URLS.coinbase()}/products/${product}/book?level=2`)) as { bids: string[][]; asks: string[][] };
  return bookStats(
    j.bids.map((b) => [Number(b[0]), Number(b[1])]),
    j.asks.map((a) => [Number(a[0]), Number(a[1])]),
  );
}

async function krakenBook(m: string) {
  const pair = m === "btc" ? "XBTUSD" : `${SYM(m)}USD`;
  const j = (await getJson(`${URLS.kraken()}/0/public/Depth?pair=${pair}&count=100`)) as {
    result?: Record<string, { bids: (string | number)[][]; asks: (string | number)[][] }>;
  };
  const book = j.result ? Object.values(j.result)[0] : undefined;
  if (!book) throw new Error("no book");
  return bookStats(
    book.bids.map((b) => [Number(b[0]), Number(b[1])]),
    book.asks.map((a) => [Number(a[0]), Number(a[1])]),
  );
}

async function venueMids(m: string, coinbaseMid: number | null, krakenMid: number | null) {
  const s = m.toLowerCase();
  const out: Record<string, number> = {};
  if (coinbaseMid) out.coinbase = coinbaseMid;
  if (krakenMid) out.kraken = krakenMid;
  const tasks: [string, () => Promise<number>][] = [
    [
      "bitstamp",
      async () => {
        const j = (await getJson(`${URLS.bitstamp()}/api/v2/ticker/${s}usd/`)) as { bid: string; ask: string };
        return (Number(j.bid) + Number(j.ask)) / 2;
      },
    ],
    [
      "gemini",
      async () => {
        const j = (await getJson(`${URLS.gemini()}/v1/pubticker/${s}usd`)) as { bid: string; ask: string };
        return (Number(j.bid) + Number(j.ask)) / 2;
      },
    ],
    [
      "crypto_com",
      async () => {
        const j = (await getJson(`${URLS.cryptocom()}/exchange/v1/public/get-tickers?instrument_name=${SYM(m)}_USD`)) as {
          result?: { data?: { b: string; k: string }[] };
        };
        const d = j.result?.data?.[0];
        if (!d) throw new Error("no ticker");
        return (Number(d.b) + Number(d.k)) / 2;
      },
    ],
  ];
  const got = await Promise.allSettled(tasks.map(([, f]) => f()));
  got.forEach((g, i) => {
    if (g.status === "fulfilled" && Number.isFinite(g.value) && g.value > 0) out[tasks[i][0]] = g.value;
  });
  const vals = Object.values(out).sort((a, b) => a - b);
  if (vals.length < 2) return null;
  const med = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  const vs: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(out)) vs[k] = r(((v - med) / med) * 1e4, 2);
  const sorted = Object.entries(vs).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return {
    vs_median_bps: vs,
    spread_between_venues_bps: r(((vals[vals.length - 1] - vals[0]) / med) * 1e4, 2),
    highest: sorted[0]?.[0],
    lowest: sorted[sorted.length - 1]?.[0],
    note: "BRTI averages these venues' books; a venue already above/below the others pulls the index that way",
  };
}

async function hyperliquid(m: string) {
  const j = (await getJson(`${URLS.hyperliquid()}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  })) as [{ universe: { name: string }[] }, Record<string, string>[]];
  const i = j[0].universe.findIndex((u) => u.name === SYM(m));
  const c = i >= 0 ? j[1][i] : undefined;
  if (!c) throw new Error("no asset");
  const mark = Number(c.markPx);
  const oracle = Number(c.oraclePx);
  return {
    perp_vs_spot_bps: r(((mark - oracle) / oracle) * 1e4, 2),
    premium_bps: r(Number(c.premium) * 1e4, 2),
    funding_rate_hourly_pct: r(Number(c.funding) * 100, 5),
    open_interest: r(Number(c.openInterest), 2),
    day_volume_usd: r(Number(c.dayNtlVlm), 0),
  };
}

async function deribit(m: string) {
  if (m !== "btc" && m !== "eth") return null;
  const j = (await getJson(`${URLS.deribit()}/api/v2/public/ticker?instrument_name=${SYM(m)}-PERPETUAL`)) as {
    result?: Record<string, number>;
  };
  const t = j.result;
  if (!t) throw new Error("no ticker");
  const bidQ = t.best_bid_amount ?? 0;
  const askQ = t.best_ask_amount ?? 0;
  return {
    perp_vs_index_bps: r(((t.mark_price - t.index_price) / t.index_price) * 1e4, 2),
    funding_8h_pct: r((t.funding_8h ?? 0) * 100, 5),
    current_funding_pct: r((t.current_funding ?? 0) * 100, 5),
    open_interest_usd: r(t.open_interest ?? NaN, 0),
    top_imbalance: bidQ + askQ > 0 ? r((bidQ - askQ) / (bidQ + askQ), 3) : null,
  };
}

/** Other coins' move since this candle opened (bitcoin leads; for BTC, ETH and SOL often move first or together). */
async function crossAssets(m: string, forTime: number) {
  const others = m === "btc" ? ["ETH-USD", "SOL-USD"] : ["BTC-USD", "ETH-USD"].filter((p) => !p.startsWith(SYM(m)));
  const out: Record<string, unknown> = {};
  await Promise.allSettled(
    others.map(async (p) => {
      const q = new URLSearchParams({
        granularity: "60",
        start: new Date((forTime - 60) * 1000).toISOString(),
        end: new Date((Date.now() / 1000 + 60) * 1000).toISOString(),
      });
      const rows = (await getJson(`${URLS.coinbase()}/products/${p}/candles?${q}`)) as number[][];
      const sorted = [...rows].sort((a, b) => a[0] - b[0]);
      const atOpen = sorted.find((x) => x[0] === forTime) ?? sorted.find((x) => x[0] >= forTime);
      const now = sorted[sorted.length - 1];
      if (!atOpen || !now) return;
      out[p.split("-")[0].toLowerCase()] = {
        move_since_candle_open_pct: r(((now[4] - atOpen[3]) / atOpen[3]) * 100, 3),
      };
    }),
  );
  return Object.keys(out).length ? out : null;
}

async function coinbaseFlow(product: string) {
  const rows = (await getJson(`${URLS.coinbase()}/products/${product}/trades?limit=1000`)) as {
    time: string;
    size: string;
    side: string;
    price: string;
  }[];
  const trades = rows.map((x) => ({
    t: Date.parse(x.time) / 1000,
    size: Number(x.size),
    buy: x.side === "sell", // the maker sold → the taker bought
    price: Number(x.price),
  }));
  return tradeFlow(trades, Date.now() / 1000);
}

function slugTime(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}z`;
}

/** Which way a Polymarket US market's YES (long) contract pays: from its sides, outcomes or settle rule. */
// deno-lint-ignore no-explicit-any
export function pmLongIs(m: any): "up" | "down" | null {
  const sideOf = (t: unknown) => (/\bup\b/i.test(String(t ?? "")) ? "up" : /\bdown\b/i.test(String(t ?? "")) ? "down" : null);
  for (const x of Array.isArray(m?.marketSides) ? m.marketSides : []) {
    const sd = sideOf(x?.description ?? x?.identifier ?? x?.name);
    if (sd && x?.long === true) return sd;
    if (sd && x?.long === false) return sd === "up" ? "down" : "up";
  }
  let outs = m?.outcomes;
  if (typeof outs === "string") {
    try {
      outs = JSON.parse(outs);
    } catch {
      outs = outs.split(",");
    }
  }
  if (Array.isArray(outs) && outs.length === 2) {
    const first = sideOf(typeof outs[0] === "object" ? outs[0]?.name ?? outs[0]?.title : outs[0]);
    if (first) return first;
  }
  const rule = /settle to (up|down)\b/i.exec(String(m?.description ?? m?.rules ?? ""));
  return rule ? (rule[1].toLowerCase() as "up" | "down") : null;
}

/** Polymarket US's own odds for this 5-minute BTC window. Left out unless the market's Up side can be read. */
async function polymarket(m: string, tfSec: number, forTime: number) {
  if (m !== "btc" || tfSec !== 300) return null;
  // deno-lint-ignore no-explicit-any
  const ev = (await getJson(`${URLS.polymarket()}/v1/events/slug/btc-updown-5m-${slugTime(forTime)}`)) as any;
  const mk = (ev?.event ?? ev)?.markets?.[0];
  const long = pmLongIs(mk);
  if (!mk?.slug || !long) throw new Error("no market");
  // deno-lint-ignore no-explicit-any
  const raw = (await getJson(`${URLS.polymarket()}/v1/markets/${mk.slug}/bbo`)) as any;
  const b = (raw?.marketData ?? raw?.marketDataLite ?? raw ?? {}) as Record<string, unknown>;
  const bid = num(b.bestBid);
  const ask = num(b.bestAsk);
  if (!Number.isFinite(bid) && !Number.isFinite(ask)) throw new Error("no prices");
  const midYes = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number.isFinite(ask) ? ask : bid;
  const pUp = long === "up" ? midYes : 1 - midYes;
  return {
    implied_p_up_pct: r(pUp * 100, 1),
    yes_pays_on: long,
    yes_best_bid: r(bid, 3),
    yes_best_ask: r(ask, 3),
    note: "the crowd's odds on this exact window; thin and can lag spot — compare with finish_probability",
  };
}

const cache = new Map<string, { at: number; v: Record<string, unknown> }>();

/** The live block for one market at this moment (cached 3 s per market and candle). */
export async function lightspeedLive(spec: LiveSpec): Promise<Record<string, unknown>> {
  const key = `${spec.market}:${spec.tfSec}:${spec.forTime}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3000) return hit.v;
  const settle = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  const product = spec.coinbase;
  const [cb, kr, hl, db, cross, flow, pm] = await Promise.all([
    product ? settle(() => coinbaseBook(product)) : null,
    settle(() => krakenBook(spec.market)),
    settle(() => hyperliquid(spec.market)),
    settle(() => deribit(spec.market)),
    settle(() => crossAssets(spec.market, spec.forTime)),
    product ? settle(() => coinbaseFlow(product)) : null,
    settle(() => polymarket(spec.market, spec.tfSec, spec.forTime)),
  ]);
  const venues = await settle(() => venueMids(spec.market, cb?.mid ?? null, kr?.mid ?? null));
  const v: Record<string, unknown> = {
    as_of_utc: new Date().toISOString(),
    ...(cb ? { coinbase_order_book: cb } : {}),
    ...(kr ? { kraken_order_book: kr } : {}),
    ...(venues ? { brti_venues: venues } : {}),
    ...(flow ? { coinbase_trade_flow_now: flow } : {}),
    ...(hl ? { hyperliquid_perp: hl } : {}),
    ...(db ? { deribit_perp: db } : {}),
    ...(cross ? { other_coins: cross } : {}),
    ...(pm ? { polymarket_crowd: pm } : {}),
  };
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 200) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
  return v;
}
