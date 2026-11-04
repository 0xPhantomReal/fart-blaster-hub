// Polymarket US bot for "BTC Up or Down: 5 min", run by a schedule every minute (pg_cron).
//
// Each 5-minute window [S, S+300):
//   minute 4 of the previous window (S−60 … S): record BRTI → the "price to beat" (60-second average)
//   S … S+30: record BRTI, then ask Jev whether the candle holds its color or flips. Every read is kept, and Jev's
//     record over the last 12 windows sets the regime:
//       Jev right lately (or unclear) → bet only when Jev says it HOLDS (any sureness over 50%); flip calls ignored
//       Jev backwards lately         → bet against Jev: its hold call → bet the reversal, its flip call → bet the hold
//     A bet = a limit order for 30 shares at 33¢ on that side, good until the window closes (optionally also a
//     market order: FADEBOT_MARKET_BET). FADEBOT_REGIME=off → hold calls only, always.
//   after S+300: settle (Polymarket's settlement; in dry mode the final-minute BRTI average)
// State lives in the project database (tables are created on first run).
//
// Secrets: SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_ANON_KEY (provided by the platform);
//   FADEBOT_MODE (dry | live, default dry), FADEBOT_LIMIT_PRICE (0.33), FADEBOT_LIMIT_SHARES (30),
//   FADEBOT_MARKET_BET (0 = none), FADEBOT_REGIME (on | off, default on); POLYMARKET_KEY_ID, POLYMARKET_SECRET_KEY (live only)
//
// POST {}                    → the scheduled run
// POST { action: "status" }  → settings, totals and recent bets (for the page)

import postgres from "npm:postgres@3.4.9";
import { PolymarketUS } from "npm:polymarket-us@0.1.1";
import { atrByTime, bodySd, flipState, greenFromFlip, type Candle } from "../_shared/flipState.ts";
import {
  pnl,
  regimeDecision,
  regimeOf,
  REGIME_N,
  winner,
  type JevHit,
  type Side,
} from "../_shared/fadeStrategy.ts";
import { authenticateCronRequest } from "../_shared/cron-auth.ts";

const TF = 300; //        5-minute windows
const READ_AT = 30; //    Jev reads the candle 30 seconds in
const env = (k: string) => Deno.env.get(k) ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const settings = () => ({
  mode: env("FADEBOT_MODE") === "live" ? "live" : "dry",
  // Market-order stake in dollars on each hold call (0 = no market order, only the limit order). No Fibonacci.
  marketBet: Number(env("FADEBOT_MARKET_BET") || 0),
  limitPrice: Number(env("FADEBOT_LIMIT_PRICE") || 0.33),
  limitShares: Number(env("FADEBOT_LIMIT_SHARES") || 30),
  regimes: env("FADEBOT_REGIME") !== "off",
});

// ── Database ───────────────────────────────────────────────────────────

let sqlConn: ReturnType<typeof postgres> | null = null;
function db() {
  if (!env("SUPABASE_DB_URL")) throw new Error("SUPABASE_DB_URL isn't available to this function");
  sqlConn ??= postgres(env("SUPABASE_DB_URL"), { prepare: false, max: 2, idle_timeout: 20 });
  return sqlConn;
}

let ready = false;
async function setup() {
  if (ready) return;
  const sql = db();
  await sql`create table if not exists fadebot_prices (
    period_start bigint primary key, avg double precision, high double precision, low double precision,
    last double precision, n int, source text, created_at timestamptz default now())`;
  await sql`create table if not exists fadebot_bets5 (
    window_start bigint primary key, mode text, status text, reason text, market_slug text, long_is text,
    jev_sure double precision, side text, step int, stake double precision,
    price double precision, shares double precision, fees double precision,
    limit_order_id text, limit_price double precision, limit_shares double precision, limit_filled double precision default 0,
    open_ref double precision, result text, pnl double precision, order_id text,
    created_at timestamptz default now(), settled_at timestamptz)`;
  await sql`create table if not exists fadebot_state5 (id int primary key, step int not null default 0,
    total_pnl double precision not null default 0, peak double precision not null default 0,
    worst_drawdown double precision not null default 0, trades int not null default 0, wins int not null default 0)`;
  await sql`insert into fadebot_state5 (id) values (1) on conflict (id) do nothing`;
  // Every 30-second Jev read (bet or not), and how the window ended: Jev's record → the regime.
  await sql`create table if not exists fadebot_reads5 (
    window_start bigint primary key, p_green double precision, move double precision, open_ref double precision,
    outcome text, created_at timestamptz default now())`;
  await sql`alter table fadebot_bets5 add column if not exists regime text`;
  await sql`alter table fadebot_bets5 add column if not exists kind text`;
  // Only this function (through the database connection) reads and writes these tables.
  await sql`alter table fadebot_prices enable row level security`;
  await sql`alter table fadebot_bets5 enable row level security`;
  await sql`alter table fadebot_state5 enable row level security`;
  await sql`alter table fadebot_reads5 enable row level security`;
  ready = true;
}

// ── Prices: record BRTI from the gold function's tick stream ──────────

const goldUrl = () => `${env("SUPABASE_URL")}/functions/v1/gold`;
const goldHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${env("SUPABASE_ANON_KEY")}`,
  apikey: env("SUPABASE_ANON_KEY"),
});

async function gold<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(goldUrl(), { method: "POST", headers: goldHeaders(), body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gold: ${(j as { error?: string }).error ?? res.status}`);
  return j as T;
}

/** BTC ticks until `until` (unix s), from the BRTI stream (Pyth if BRTI isn't available). */
async function record(until: number): Promise<{ ticks: { t: number; p: number }[]; source: string }> {
  const ticks: { t: number; p: number }[] = [];
  let source = "?";
  while (Date.now() / 1000 < until - 0.5) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(0, (until - Date.now() / 1000) * 1000));
    try {
      const res = await fetch(goldUrl(), {
        method: "POST",
        headers: goldHeaders(),
        body: JSON.stringify({ action: "stream", market: "btc" }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.source) source = m.source;
          else if (typeof m.t === "number" && typeof m.p === "number") ticks.push({ t: m.t, p: m.p });
        }
      }
    } catch {
      // aborted at the deadline, or the stream dropped: reconnect if there's time left
    } finally {
      clearTimeout(timer);
    }
  }
  return { ticks, source };
}

/** Save the ticks in [from, to) as one row keyed by `from`. */
async function savePeriod(from: number, to: number, ticks: { t: number; p: number }[], source: string) {
  const ps = ticks.filter((x) => x.t >= from && x.t < to).map((x) => x.p);
  if (!ps.length) return;
  const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
  await db()`insert into fadebot_prices (period_start, avg, high, low, last, n, source)
    values (${from}, ${avg}, ${Math.max(...ps)}, ${Math.min(...ps)}, ${ps[ps.length - 1]}, ${ps.length}, ${source})
    on conflict (period_start) do update set avg = excluded.avg, high = excluded.high, low = excluded.low,
      last = excluded.last, n = excluded.n, source = excluded.source`;
}

async function period(from: number) {
  const r = await db()`select * from fadebot_prices where period_start = ${from}`;
  return r[0] as { avg: number; high: number; low: number; last: number; n: number; source: string } | undefined;
}

// ── Polymarket US ──────────────────────────────────────────────────────

const pm = () =>
  new PolymarketUS({
    keyId: env("POLYMARKET_KEY_ID") || undefined,
    secretKey: env("POLYMARKET_SECRET_KEY") || undefined,
    ...(env("PM_GATEWAY_URL") ? { gatewayBaseUrl: env("PM_GATEWAY_URL") } : {}),
    ...(env("PM_API_URL") ? { apiBaseUrl: env("PM_API_URL") } : {}),
  });

interface WindowMarket {
  slug: string;
  longIs: Side; // which outcome the YES (long) contract pays on
}

/** What the last market search saw, for the "no market found" message. */
let lastSearch = "";
let lastListError = "";

type Ev = {
  slug: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  markets?: { slug: string; outcome?: string; title?: string; description?: string }[];
};

/** Which outcome the YES (long) contract pays on, from the market's outcome/title. */
function longSide(m: { outcome?: string; title?: string }): Side | null {
  for (const t of [m.outcome ?? "", m.title ?? ""]) {
    const up = /\bup\b/i.test(t);
    const down = /\bdown\b/i.test(t);
    if (up && !down) return "up";
    if (down && !up) return "down";
  }
  return null;
}

/** Polymarket US slug label for a window start: 2026-11-04-1915z (UTC). */
function slugTime(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}z`;
}

/** Window start from an event: the time in its slug (2026-11-04-1915z or a unix timestamp), else its start/end times. */
function windowOf(e: Ev): number | null {
  const dt = e.slug.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})z/i);
  if (dt) return Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5]) / 1000;
  const ts = e.slug.match(/(\d{10})(?!\d)/);
  if (ts) return Number(ts[1]);
  const en = e.endTime ? Date.parse(e.endTime) / 1000 : NaN;
  if (Number.isFinite(en)) return en - TF;
  const s = e.startTime ? Date.parse(e.startTime) / 1000 : NaN;
  return Number.isFinite(s) ? s : null;
}

async function marketsOf(e: Ev) {
  if (e.markets?.length) return e.markets;
  const r = await pm().markets.list({ eventSlug: [e.slug] }).catch(() => ({ markets: [] }));
  return (r.markets ?? []) as NonNullable<Ev["markets"]>;
}

/** The BTC 5-minute Up/Down market covering [start, start + 300). */
async function findMarket(start: number): Promise<WindowMarket | null> {
  const client = pm();
  const seen = new Map<string, Ev>();
  // 1. Direct slugs. Polymarket US: btc-updown-5m-2026-11-04-1915z (window start, UTC); the international site
  //    uses a unix timestamp. Search alone only turned up the previous window's market.
  let direct = "";
  for (const slug of [`btc-updown-5m-${slugTime(start)}`, `btc-updown-5m-${start}`]) {
    const r = await client.events.retrieveBySlug(slug).catch((e) => {
      direct ||= `${slug}: ${(e as Error).message}`.slice(0, 160);
      return null;
    });
    const e = (r as { event?: Ev } | null)?.event;
    if (e) {
      seen.set(e.slug, e);
      break;
    }
  }
  // 2. Events ending around this window's close (doesn't depend on how search ranks things).
  const iso = (t: number) => new Date(t * 1000).toISOString();
  for (const params of [
    { active: true, closed: false, endDateMin: iso(start + TF - 30), endDateMax: iso(start + TF + 30), limit: 100 },
    { closed: false, endDateMin: iso(start + TF - 30), endDateMax: iso(start + TF + 30), limit: 100 },
  ]) {
    const r = await client.events.list(params).catch((e) => {
      lastListError = (e as Error).message;
      return { events: [] };
    });
    for (const e of (r.events ?? []) as Ev[]) seen.set(e.slug, e);
  }
  // 3. Search.
  for (const query of ["Bitcoin Up or Down", "BTC Up or Down", "Bitcoin Up or Down 5 minutes", "BTC 5m"]) {
    const r = await client.search.query({ query, limit: 100 }).catch(() => ({ events: [] }));
    for (const e of (r.events ?? []) as Ev[]) seen.set(e.slug, e);
  }
  const btc = [...seen.values()].filter((e) => /btc|bitcoin/i.test(`${e.title ?? ""} ${e.slug}`));
  const fiveMin = btc.filter((e) => {
    const s = e.startTime ? Date.parse(e.startTime) / 1000 : NaN;
    const en = e.endTime ? Date.parse(e.endTime) / 1000 : NaN;
    const text = `${e.slug} ${e.title ?? ""}`;
    // Not the 15-minute, hourly or longer markets (their start times can line up with a 5-minute window).
    if (/(^|[^0-9])(1[05]|30|60)\s?(m|min)|\b(1h|4h|hour|daily|1d)\b/i.test(text)) return false;
    if (/(^|[^0-9])5\s?(m|min)/i.test(text)) return true;
    return Math.abs(en - s - TF) < 5; // no label: go by duration (start time may be when the event was created)
  });
  for (const e of fiveMin) {
    const w = windowOf(e);
    if (w === null || Math.abs(w - start) >= 5) continue;
    const markets = await marketsOf(e);
    for (const m of markets) {
      const longIs = longSide(m);
      if (longIs) return { slug: m.slug, longIs };
    }
    lastSearch = `found ${e.slug} but couldn't tell whether its contract pays on Up or Down: ${JSON.stringify(markets.slice(0, 2)).slice(0, 200)}`;
    return null;
  }
  const sample = (fiveMin.length ? fiveMin : btc)
    .slice(0, 4)
    .map((e) => `${e.slug} [${e.startTime ?? "?"} → ${e.endTime ?? "?"}]`)
    .join("; ");
  const any = [...seen.values()].slice(0, 3).map((e) => `${e.slug} "${e.title ?? ""}"`).join("; ");
  lastSearch = `${direct ? `direct lookup failed (${direct}); ` : ""}saw ${seen.size} events, ${btc.length} bitcoin, ${fiveMin.length} 5-minute${sample ? `: ${sample}` : any ? `; e.g. ${any}` : ""}${lastListError ? `; list error: ${lastListError}` : ""}`;
  return null;
}

/** Cost of one share of `side` now (0–1). The book is quoted in YES prices: NO costs 1 − the best YES bid. */
async function priceFor(m: WindowMarket, side: Side): Promise<number | null> {
  const b = await pm().markets.bbo(m.slug);
  if (side === m.longIs) return b.bestAsk ? Number(b.bestAsk.value) : null;
  return b.bestBid ? Number((1 - Number(b.bestBid.value)).toFixed(4)) : null;
}

const intentFor = (m: WindowMarket, side: Side): "ORDER_INTENT_BUY_LONG" | "ORDER_INTENT_BUY_SHORT" =>
  side === m.longIs ? "ORDER_INTENT_BUY_LONG" : "ORDER_INTENT_BUY_SHORT";

/** Market order for about `dollars` of `side`. */
async function marketBuy(m: WindowMarket, side: Side, dollars: number) {
  const r = await pm().orders.create({
    marketSlug: m.slug,
    intent: intentFor(m, side),
    type: "ORDER_TYPE_MARKET",
    cashOrderQty: { value: dollars.toFixed(2), currency: "USD" },
    manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
    synchronousExecution: true,
    maxBlockTime: "5",
  });
  let shares = 0;
  let notional = 0;
  let fees = 0;
  for (const x of r.executions ?? []) {
    const q = Number(x.lastShares ?? 0);
    if (q > 0) {
      shares += q;
      notional += q * Number(x.lastPx?.value ?? 0);
    }
    fees += Number(x.commissionNotionalCollected?.value ?? 0);
  }
  if (!shares) return { id: r.id, shares: 0, price: 0, fees };
  let price = notional / shares;
  // Fills may be reported in YES prices: for the NO side take whichever matches what was spent.
  if (side !== m.longIs && Math.abs(shares * (1 - price) - dollars) < Math.abs(shares * price - dollars)) price = 1 - price;
  return { id: r.id, shares, price, fees };
}

/** Resting limit order: `shares` of `side` at `price` (our side's price), good until `until`. */
async function limitBuy(m: WindowMarket, side: Side, price: number, shares: number, until: number) {
  const yesPrice = side === m.longIs ? price : 1 - price; // prices are always the YES price
  const r = await pm().orders.create({
    marketSlug: m.slug,
    intent: intentFor(m, side),
    type: "ORDER_TYPE_LIMIT",
    price: { value: yesPrice.toFixed(2), currency: "USD" },
    quantity: shares,
    tif: "TIME_IN_FORCE_GOOD_TILL_DATE",
    goodTillTime: new Date(until * 1000).toISOString(),
    manualOrderIndicator: "MANUAL_ORDER_INDICATOR_AUTOMATIC",
  });
  return r.id;
}

async function filledQty(orderId: string): Promise<number> {
  const r = await pm().orders.retrieve(orderId);
  return Number(r.order?.cumQuantity ?? 0);
}

async function settledSide(m: WindowMarket): Promise<Side | null> {
  try {
    const s = await pm().markets.settlement(m.slug);
    const v = Number(s.settlementPrice?.value);
    if (!Number.isFinite(v)) return null;
    return v >= 0.5 ? m.longIs : m.longIs === "up" ? "down" : "up";
  } catch {
    return null;
  }
}

// ── Regime: Jev's recent record at 30 seconds ─────────────────────────

/** Fill in how recent windows ended (from the recorded final-minute BRTI average), then return Jev's hits. */
async function jevHits(now: number, fill = true): Promise<JevHit[]> {
  const sql = db();
  const open = fill
    ? await sql`select * from fadebot_reads5 where outcome is null and window_start + ${TF} <= ${now}
        and window_start > ${now - 86400} order by window_start`
    : [];
  for (const r of open) {
    const fin = await period(Number(r.window_start) + TF - 60);
    if (!fin || fin.n < 20) continue;
    await sql`update fadebot_reads5 set outcome = ${winner(r.open_ref, fin.avg)} where window_start = ${r.window_start}`;
  }
  const rows = await sql`select * from fadebot_reads5 where outcome is not null and p_green <> 0.5
    order by window_start desc limit 300`;
  return rows
    .reverse()
    .map((r) => ({ time: Number(r.window_start), hit: (r.p_green > 0.5) === (r.outcome === "up") }));
}

/** Jev right after a hit vs after a miss (back-to-back windows): whether the regimes last. */
function persistence(hits: JevHit[]) {
  const a = { right: 0, n: 0 };
  const b = { right: 0, n: 0 };
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].time - hits[i - 1].time !== TF) continue;
    const x = hits[i - 1].hit ? a : b;
    x.n += 1;
    if (hits[i].hit) x.right += 1;
  }
  return { afterHit: a, afterMiss: b };
}

// ── The bot ────────────────────────────────────────────────────────────

async function skip(start: number, reason: string) {
  await db()`insert into fadebot_bets5 (window_start, mode, status, reason) values (${start}, ${settings().mode}, 'skipped', ${reason})
    on conflict (window_start) do nothing`;
}

/** 30 seconds into window `start`: ask Jev; on a hold call, market order + resting limit order. */
async function decideWindow(start: number) {
  const sql = db();
  if ((await sql`select 1 from fadebot_bets5 where window_start = ${start}`).length) return;
  const cfg = settings();
  const before = await period(start - 60);
  const first = await period(start);
  if (!before || before.n < 20) return skip(start, "no price to beat (the minute before the window wasn't recorded)");
  if (!first || first.n < 3) return skip(start, "no prices recorded in the first 30 seconds");
  const openRef = before.avg;
  const forming: Candle = {
    time: start,
    open: openRef,
    high: Math.max(openRef, first.high),
    low: Math.min(openRef, first.low),
    close: first.last,
  };
  const hist = await gold<{ candles: Candle[] }>({ action: "history", market: "btc", resolution: 5, from: start - 86400, to: start });
  const closed = hist.candles.filter((c) => c.time + TF <= start);
  const atr = atrByTime(closed).get(closed[closed.length - 1]?.time);
  const sd = bodySd(closed);
  if (!atr || !sd) return skip(start, "not enough candle history");
  const state = flipState({ forming, secondsLeft: start + TF - Date.now() / 1000, tfSeconds: TF, atr, sd, previous: closed.slice(-15) });
  if (!state) return skip(start, "price exactly at the price to beat");
  const { pFlip } = await gold<{ pFlip: number }>({ action: "flip", market: "btc", timeframeMin: 5, state, slotKey: `bot:s30:${start}` });
  const move = forming.close - forming.open;
  const pGreen = greenFromFlip(move, pFlip);
  await sql`insert into fadebot_reads5 (window_start, p_green, move, open_ref) values (${start}, ${pGreen}, ${move}, ${openRef})
    on conflict (window_start) do nothing`;
  const reg = cfg.regimes
    ? regimeOf(await jevHits(start), start, TF)
    : { regime: "unsure" as const, right: 0, n: 0 };
  const regLabel = cfg.regimes
    ? `${reg.regime === "normal" ? "Jev right" : reg.regime === "backwards" ? "Jev backwards" : "unclear"} (${reg.right}/${reg.n})`
    : "regimes off";
  const d = regimeDecision(pGreen, move, reg.regime);
  if (!d) {
    await skip(start, `Jev called a flip (${Math.round(pFlip * 100)}%), regime ${regLabel}: no bet`);
    await sql`update fadebot_bets5 set regime = ${regLabel} where window_start = ${start}`;
    return;
  }

  const stake = cfg.marketBet;
  const market = await findMarket(start).catch(() => null);
  if (!market) {
    const call = `Jev: ${d.kind === "hold" ? "holds" : d.kind === "fade-hold" ? "holds, faded" : "flip, faded"} → ${d.side} (${Math.round(d.sure * 100)}%)`;
    await skip(start, `${call}, but no Polymarket 5-minute market found for this window (${lastSearch})`.slice(0, 700));
    await sql`update fadebot_bets5 set regime = ${regLabel}, kind = ${d.kind} where window_start = ${start}`;
    return;
  }

  let price: number | null = await priceFor(market, d.side).catch(() => null);
  let shares = 0;
  let fees = 0;
  let orderId: string | null = null;
  let limitId: string | null = null;
  if (cfg.mode === "live") {
    if (stake > 0) {
      try {
        const f = await marketBuy(market, d.side, stake);
        orderId = f.id;
        shares = f.shares;
        fees = f.fees;
        if (shares > 0) price = f.price;
      } catch (e) {
        console.error("market order failed:", (e as Error).message);
      }
    }
    try {
      limitId = await limitBuy(market, d.side, cfg.limitPrice, cfg.limitShares, start + TF);
    } catch (e) {
      if (!shares) return skip(start, `limit order failed: ${(e as Error).message}`.slice(0, 300));
      console.error("limit order failed:", (e as Error).message);
    }
  } else if (stake > 0 && price && price > 0) shares = stake / price;
  await sql`insert into fadebot_bets5 (window_start, mode, status, market_slug, long_is, jev_sure, side, step, stake, price, shares, fees,
      limit_order_id, limit_price, limit_shares, limit_filled, open_ref, order_id, regime, kind)
    values (${start}, ${cfg.mode}, 'open', ${market.slug}, ${market.longIs}, ${d.sure}, ${d.side}, 0, ${stake}, ${price ?? 0},
      ${shares}, ${fees}, ${limitId}, ${cfg.limitPrice}, ${cfg.limitShares}, 0, ${openRef}, ${orderId}, ${regLabel}, ${d.kind})
    on conflict (window_start) do nothing`;
}

/** Dry runs: count the limit order as filled if our side's price has dropped to the limit (checked once a minute). */
async function dryLimitCheck() {
  const sql = db();
  const now = Math.floor(Date.now() / 1000);
  const open = await sql`select * from fadebot_bets5 where status = 'open' and mode = 'dry' and limit_filled = 0
    and window_start + ${TF} > ${now}`;
  for (const b of open) {
    const p = await priceFor({ slug: b.market_slug, longIs: b.long_is }, b.side).catch(() => null);
    if (p !== null && p <= b.limit_price) {
      await sql`update fadebot_bets5 set limit_filled = ${b.limit_shares} where window_start = ${b.window_start}`;
    }
  }
}

/** Settle bets whose window has ended. */
async function settle() {
  const sql = db();
  const now = Math.floor(Date.now() / 1000);
  const open = await sql`select * from fadebot_bets5 where status = 'open' and window_start + ${TF + 70} <= ${now} order by window_start`;
  for (const b of open) {
    const end = Number(b.window_start) + TF;
    const m = { slug: b.market_slug, longIs: b.long_is } as WindowMarket;
    let won: Side | null = await settledSide(m);
    if (!won) {
      const fin = await period(end - 60);
      // Dry runs settle on our own BRTI record; live waits up to 15 minutes for Polymarket's settlement.
      if (fin && fin.n >= 20 && (b.mode === "dry" || now > end + 900)) won = winner(b.open_ref, fin.avg);
      else if (now > end + 3600) {
        await sql`update fadebot_bets5 set status = 'void', reason = 'could not settle' where window_start = ${b.window_start}`;
        continue;
      }
    }
    if (!won) continue;
    let limitFilled = Number(b.limit_filled ?? 0);
    if (b.mode === "live" && b.limit_order_id) limitFilled = await filledQty(b.limit_order_id).catch(() => limitFilled);
    const ok = won === b.side;
    const p = pnl(Number(b.shares ?? 0), Number(b.price ?? 0), ok) + pnl(limitFilled, b.limit_price, ok) - (b.fees ?? 0);
    if (!(Number(b.shares ?? 0) > 0) && !(limitFilled > 0)) {
      // Nothing bought (the limit never filled): no trade.
      await sql`update fadebot_bets5 set status = 'settled', result = 'no fill', pnl = 0, limit_filled = 0, settled_at = now()
        where window_start = ${b.window_start} and status = 'open'`;
      continue;
    }
    await sql.begin(async (tx) => {
      const upd = await tx`update fadebot_bets5 set status = 'settled', result = ${ok ? "win" : "loss"}, pnl = ${p},
          limit_filled = ${limitFilled}, settled_at = now()
        where window_start = ${b.window_start} and status = 'open' returning 1`;
      if (!upd.length) return;
      const st = (await tx`select * from fadebot_state5 where id = 1 for update`)[0];
      const total = st.total_pnl + p;
      const peak = Math.max(st.peak, total);
      await tx`update fadebot_state5 set step = 0, total_pnl = ${total},
        peak = ${peak}, worst_drawdown = ${Math.max(st.worst_drawdown, peak - total)}, trades = ${st.trades + 1},
        wins = ${st.wins + (ok ? 1 : 0)} where id = 1`;
    });
  }
}

async function run() {
  await setup();
  const now = Date.now() / 1000;
  const start = Math.floor(now / TF) * TF;
  const m = Math.floor((now - start) / 60);
  const done: string[] = [];
  await dryLimitCheck().catch(() => {});
  if (m === 4) {
    // The last minute of this window = the next window's price to beat (and this window's settlement minute).
    const from = start + 240;
    const { ticks, source } = await record(from + 58);
    await savePeriod(from, from + 60, ticks, source);
    done.push(`recorded the price to beat (${ticks.length} ticks from ${source})`);
  } else if (m === 0) {
    const { ticks, source } = await record(start + READ_AT);
    await savePeriod(start, start + READ_AT, ticks, source);
    done.push(`recorded the first 30 seconds (${ticks.length} ticks from ${source})`);
    await decideWindow(start).catch((e) => skip(start, `error: ${(e as Error).message}`.slice(0, 300)));
    done.push("decided");
  }
  await settle();
  await db()`delete from fadebot_prices where period_start < ${Math.floor(now - 3 * 86400)}`;
  if (m !== 0) await jevHits(Math.floor(now)).catch(() => []); // keep outcomes filled in for the page
  return done;
}

async function status() {
  await setup();
  const sql = db();
  const st = (await sql`select * from fadebot_state5 where id = 1`)[0];
  const bets = await sql`select * from fadebot_bets5 order by window_start desc limit 30`;
  const cfg = settings();
  const now = Math.floor(Date.now() / 1000);
  const hits = await jevHits(now, false); // read-only here
  const next = Math.floor(now / TF) * TF + (now % TF >= READ_AT ? TF : 0); // the next window Jev reads
  const reg = regimeOf(hits, next, TF);
  return {
    settings: cfg,
    state: st,
    nextStake: cfg.marketBet,
    bets,
    regime: { ...reg, window: REGIME_N, reads: hits.length, ...persistence(hits) },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "status") return json(await status());
    if (body?.action === "find-market") {
      // Read-only: which Polymarket market the bot would trade for the current window.
      const start = Math.floor(Date.now() / 1000 / TF) * TF;
      const m = await findMarket(start);
      return json({ window: new Date(start * 1000).toISOString(), market: m, search: lastSearch });
    }
    const authFailure = authenticateCronRequest(req);
    if (authFailure) return authFailure;
    // Test hook (only with FADEBOT_ALLOW_TEST=1, never set in production): decide the current window now.
    if (body?.action === "test-decide" && env("FADEBOT_ALLOW_TEST") === "1") {
      await setup();
      const start = Math.floor(Date.now() / 1000 / TF) * TF;
      const { ticks, source } = await record(Date.now() / 1000 + 5);
      await savePeriod(start, start + TF, ticks.map((t) => ({ ...t, t: start + 1 })), source);
      await decideWindow(start);
      await dryLimitCheck();
      await settle();
      return json(await status());
    }
    return json({ ok: true, done: await run() });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
