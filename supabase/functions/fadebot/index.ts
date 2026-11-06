// Polymarket US bot for "BTC Up or Down: 5 min", run by a schedule every minute (pg_cron).
//
// Each 5-minute window [S, S+300):
//   minute 4 of the previous window (S−60 … S): record BRTI → the "price to beat" (60-second average)
//   S … S+READ: record BRTI, then (FADEBOT_READ_SEC: 30, 60, 120 or 180 seconds in, default 30) ask Jev whether the candle ends green or red, with
//     exactly the website's "Jev at minute N" question: the candle as the website builds it, the last 15 candles,
//     market context and Coinbase order flow (kept current every minute), and the same request key, so the two
//     share one answer when they ask within a minute.
//     The EMA rule, at that read:
//       bet WITH Jev's call (hold or flip) only when the EMAs agree with it:
//       Jev calls up and the fast EMA (9) is above the slow EMA (21) → bet up
//       Jev calls down and the fast EMA is below the slow EMA → bet down
//       …and only when the EMAs are at least $60 apart (FADEBOT_EMA_GAP); otherwise no bet.
//       Flip calls also need the regime to be "Jev right" (FADEBOT_FLIP_REGIME=off to drop that).
//     EMAs under $60 apart: a HOLD call the same color as the last closed candle (or a FLIP call the opposite
//       color), with the EMAs pointing against Jev → bet AGAINST Jev's call (the EMAs' way); else no bet. Any confidence over 50%. EMAs: the chart's live lines (FADEBOT_EMA_TF 5 or 15 minutes).
//     A bet = a limit order for 15 shares at 33¢ (FADEBOT_LIMIT_SHARES / FADEBOT_LIMIT_PRICE), good until the window
//     closes. Every read is kept; Jev's record over the last 12 windows is shown as the regime.
//   after S+300: settle (Polymarket's settlement; in dry mode the final-minute BRTI average)
// State lives in the project database (tables are created on first run).
//
// Secrets: SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_ANON_KEY (provided by the platform);
//   FADEBOT_MODE (dry | live, default dry), FADEBOT_LIMIT_SHARES (15), FADEBOT_LIMIT_PRICE (0.33), FADEBOT_EMA_TF (5),
//   FADEBOT_MARKET_BET (0 = no market order), FADEBOT_READ_SEC (30); POLYMARKET_KEY_ID, POLYMARKET_SECRET_KEY (live only)
//
// POST {}                    → the scheduled run
// POST { action: "status" }  → settings, totals and recent bets (for the page)

import postgres from "npm:postgres@3.4.9";
import { PolymarketUS } from "npm:polymarket-us@0.1.1";
import { atrByTime, bodySd, flipState, greenFromFlip, type Candle } from "../_shared/flipState.ts";
import {
  emaRuleDecision,
  pnl,
  regimeOf,
  REGIME_N,
  winner,
  type JevHit,
  type Side,
} from "../_shared/fadeStrategy.ts";
import { authenticateCronRequest } from "../_shared/cron-auth.ts";
import {
  addTrade,
  emptyFootprint,
  flowContext,
  flowSoFar,
  loadTradeHistory,
  marketContext,
  niceStep,
  type Footprint,
} from "../_shared/jevContext.ts";
import { runTvIndicator, tvContext } from "../_shared/tvIndicator.ts";

const TF = 300; //        5-minute windows
// Jev reads the candle this many seconds in: FADEBOT_READ_SEC = 3, 5, 15, 30, 60, 120 or 180 (default 30). The
// page's "Jev at …" choices are the same, so the two share one answer.
const READ_AT = (() => {
  const v = Number(Deno.env.get("FADEBOT_READ_SEC") || (Number(Deno.env.get("FADEBOT_READ_MIN")) * 60 || 30));
  return [3, 5, 15, 30, 60, 120, 180].includes(v) ? v : 30;
})();
const READ_MIN = Math.ceil(READ_AT / 60); // minutes of BRTI to record before the read
// Reads in the first few seconds can't wait for the window's own scheduled run (it starts a few seconds late), so
// the previous window's last run keeps recording past the open and makes the call.
const EARLY = READ_AT <= 15;
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
  // Each bet: a limit order for this many shares at this price on the chosen side, good until the window closes.
  limitPrice: Number(env("FADEBOT_LIMIT_PRICE") || 0.33),
  limitShares: Number(env("FADEBOT_LIMIT_SHARES") || 15),
  // Optional market order in dollars on top (default none). The old FADEBOT_STAKE is no longer used.
  marketBet: Number(env("FADEBOT_MARKET_BET") || 0),
  // The EMA rule's fast/slow EMAs (9/21, as the chart's TV indicator draws them) on 5- or 15-minute candles.
  emaTf: env("FADEBOT_EMA_TF") === "15" ? 15 : 5,
  // …and only when the two EMAs are at least this many dollars apart.
  emaGap: Number(env("FADEBOT_EMA_GAP") || 60),
  // Flip trades only in the "Jev right" regime (Jev right on more than half of its last 12 reads); off = any regime.
  flipNeedsRegime: env("FADEBOT_FLIP_REGIME") !== "off",
  readAt: READ_AT,
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
  // Order flow, as the website builds it: Coinbase trades → a footprint per 5-minute candle (with 30-second slices).
  await sql`create table if not exists fadebot_flow (time bigint primary key, fp jsonb not null)`;
  await sql`alter table fadebot_flow enable row level security`;
  await sql`alter table fadebot_state5 add column if not exists flow_until double precision`;
  await sql`alter table fadebot_state5 add column if not exists flow_from double precision`;
  await sql`alter table fadebot_state5 add column if not exists flow_step double precision`;
  // Every 30-second Jev read (bet or not), and how the window ended: Jev's record → the regime.
  await sql`create table if not exists fadebot_reads5 (
    window_start bigint primary key, p_green double precision, move double precision, open_ref double precision,
    outcome text, created_at timestamptz default now())`;
  await sql`alter table fadebot_bets5 add column if not exists regime text`;
  await sql`alter table fadebot_bets5 add column if not exists kind text`;
  await sql`alter table fadebot_bets5 add column if not exists tv15 text`;
  // Polymarket's own price history per 5-minute market: the lowest Up and Down prices during the window.
  await sql`create table if not exists fadebot_pmhist (
    window_start bigint primary key, slug text, long_is text, up_low double precision, down_low double precision,
    up_read double precision, down_read double precision, n_points int, error text, sample text,
    fetched_at timestamptz default now())`;
  await sql`alter table fadebot_pmhist enable row level security`;
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
let lastMarket: unknown = null; // the market record last looked at, for the "Check Polymarket market" button
let lastHow = ""; //               how the YES side was worked out

type Ev = {
  slug: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  markets?: { slug: string; outcome?: string; title?: string; description?: string }[];
};

const sideOf = (t: unknown): Side | null => {
  const s = String(t ?? "");
  const up = /\b(up|higher|above)\b/i.test(s);
  const down = /\b(down|lower|below)\b/i.test(s);
  return up && !down ? "up" : down && !up ? "down" : null;
};

/** Which outcome the YES (long) contract pays on. Tries, in order: a per-side list with a long flag, the outcomes
 * list (the first one is YES), and the market's own outcome/title. */
// deno-lint-ignore no-explicit-any
function longSide(m: any): { side: Side; how: string } | null {
  for (const key of ["marketSides", "sides", "outcomeSides"]) {
    const list = m?.[key];
    if (!Array.isArray(list)) continue;
    for (const x of list) {
      const sd = sideOf(x?.description ?? x?.identifier ?? x?.name ?? x?.outcome ?? x?.title);
      if (!sd) continue;
      if (x?.long === true || x?.isLong === true) return { side: sd, how: `${key}: long = ${sd}` };
      if (x?.long === false || x?.isLong === false) return { side: sd === "up" ? "down" : "up", how: `${key}: short = ${sd}` };
    }
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
    if (first) return { side: first, how: `outcomes[0] = ${first}` };
  }
  for (const t of [m?.outcome, m?.title, m?.groupItemTitle]) {
    const sd = sideOf(t);
    if (sd) return { side: sd, how: `outcome/title = ${sd}` };
  }
  // The settle rule: "This market will settle to Up if the Bitcoin price at the end … is greater than or equal to …"
  // → the contract settles to (pays on) Up. Checked against real settlements before any live bet (checkLong).
  for (const key of ["description", "rules", "resolutionRules", "settlementRules"]) {
    const t = String(m?.[key] ?? "");
    const r = t.match(/\b(?:settle|resolve)[sd]?\s+(?:to|as)\s+["“'‘]?(up|down)\b[^.]{0,200}?\bif\b/i);
    if (r) return { side: r[1].toLowerCase() as Side, how: `settle rule in ${key}: settles to ${r[1]}` };
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
      let ls = longSide(m);
      if (!ls) {
        // The list view may leave sides out: ask for the market itself.
        const full = await client.markets.retrieveBySlug(m.slug).catch(() => null);
        // deno-lint-ignore no-explicit-any
        const fm = (full as any)?.market ?? full;
        if (fm) {
          lastMarket = fm;
          ls = longSide(fm);
        }
      }
      if (ls) {
        lastHow = ls.how;
        return { slug: m.slug, longIs: ls.side };
      }
    }
    lastMarket ??= markets[0] ?? null;
    lastSearch = `found ${e.slug} but couldn't tell whether its contract pays on Up or Down (tap "Check Polymarket market" for the full record)`;
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

/**
 * Check the YES side against real results: for recent windows that Polymarket has settled and whose direction is
 * clear from our own BRTI record (moved $10+), YES won ⇔ the window went `longIs`'s way. Cached once confirmed.
 */
let longChecked: { side: Side; note: string } | null = null;
async function checkLong(start: number, longIs: Side): Promise<{ ok: boolean | null; note: string }> {
  if (longChecked) {
    return longChecked.side === longIs
      ? { ok: true, note: longChecked.note }
      : { ok: false, note: `YES side read as ${longIs}, but earlier settlements showed ${longChecked.side}` };
  }
  const client = pm();
  let agree = 0;
  let disagree = 0;
  const seen: string[] = [];
  // Why windows couldn't be used (shown in the row, so a stuck check can be fixed).
  const why: Record<string, number> = {};
  let firstErr = "";
  const miss = (k: string, detail = "") => {
    why[k] = (why[k] ?? 0) + 1;
    if (detail && !firstErr) firstErr = detail.slice(0, 250);
  };
  for (let ws = start - 2 * TF; ws >= start - 14 * TF && agree < 2 && disagree < 2; ws -= TF) {
    const open = await period(ws - 60);
    const fin = await period(ws + TF - 60);
    if (!open || !fin || open.n < 20 || fin.n < 20) {
      miss("no BRTI record");
      continue;
    }
    if (Math.abs(fin.avg - open.avg) < 10) {
      miss("moved under $10");
      continue;
    }
    const went: Side = fin.avg >= open.avg ? "up" : "down";
    const evSlug = `btc-updown-5m-${slugTime(ws)}`;
    const r = await client.events.retrieveBySlug(evSlug).catch((e) => {
      miss("event lookup failed", `${evSlug}: ${(e as Error).message}`);
      return null;
    });
    const ev = (r as { event?: Ev } | null)?.event;
    const mk = ev ? (await marketsOf(ev))[0] : undefined;
    if (!mk) {
      if (r) miss("event has no market", `${evSlug}: ${JSON.stringify(r).slice(0, 200)}`);
      continue;
    }
    const st = await client.markets.settlement(mk.slug).catch((e) => {
      miss("settlement lookup failed", `${mk.slug}: ${(e as Error).message}`);
      return null;
    });
    const v = settleValue(st);
    if (!Number.isFinite(v)) {
      if (st) miss("settlement unreadable", `${mk.slug}: ${JSON.stringify(st).slice(0, 200)}`);
      continue;
    }
    const yesWon = v >= 0.5;
    const ok = yesWon === (went === longIs);
    if (ok) agree += 1;
    else disagree += 1;
    seen.push(`${slugTime(ws)} went ${went}, YES ${yesWon ? "won" : "lost"}`);
  }
  const note = seen.join("; ");
  if (disagree > 0) return { ok: false, note: `settlements don't match YES = ${longIs}: ${note}` };
  if (agree >= 2) {
    longChecked = { side: longIs, note: `confirmed by settlements: ${note}` };
    return { ok: true, note: longChecked.note };
  }
  const whyText = Object.entries(why)
    .map(([k, n]) => `${k} ×${n}`)
    .join(", ");
  return {
    ok: null,
    note: `not confirmed yet (${agree} settled window${agree === 1 ? "" : "s"} checked${note ? `: ${note}` : ""}${whyText ? `; skipped: ${whyText}` : ""}${firstErr ? `; e.g. ${firstErr}` : ""})`,
  };
}

/** Polymarket US settlement value (1 = YES won, 0 = YES lost), from either response shape. */
// deno-lint-ignore no-explicit-any
function settleValue(st: any): number {
  return Number(st?.settlement ?? st?.settlementPrice?.value ?? st?.settlementPrice ?? st?.value);
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
    const v = settleValue(await pm().markets.settlement(m.slug));
    if (!Number.isFinite(v)) return null;
    return v >= 0.5 ? m.longIs : m.longIs === "up" ? "down" : "up";
  } catch {
    return null;
  }
}

// ── The website's read: same candles, context and order flow ──────────

/** BTC 5m candles from the gold function (the same history the website loads), oldest first. */
async function closedCandles(before: number, days: number): Promise<Candle[]> {
  const r = await gold<{ candles: Candle[] }>({ action: "history", market: "btc", resolution: 5, from: before - days * 86400, to: before });
  return r.candles.filter((c) => c.time + TF <= before).sort((a, b) => a.time - b.time);
}

/** Add new Coinbase trades to the stored footprints (every run). Footprints are continuous from `flow_from`. */
async function updateFlow(now: number, atr: number | null) {
  const sql = db();
  const st = (await sql`select flow_until, flow_from, flow_step from fadebot_state5 where id = 1`)[0] ?? {};
  let step = st.flow_step as number | null;
  if (!step) {
    if (!atr) return;
    step = niceStep(atr);
    await sql`update fadebot_state5 set flow_step = ${step} where id = 1`;
  }
  const backfill = now - 22 * TF; // the website keeps 20+ candles of order flow
  const until = st.flow_until as number | null;
  const gap = !until || until < backfill;
  const from = gap ? backfill : until;
  if (now - from < 1) return;
  const fps = new Map<number, Footprint>();
  const first = Math.floor(from / TF) * TF;
  for (const r of await sql`select time, fp from fadebot_flow where time >= ${first}`) fps.set(Number(r.time), r.fp as Footprint);
  if (gap) for (const t of [...fps.keys()]) fps.delete(t); // starting over: drop partial candles
  const touched = new Set<number>();
  const ok = await loadTradeHistory(
    (after) =>
      gold<{ trades: [number, number, number, number, number][]; minId: number | null; maxId: number | null }>({
        action: "trades",
        market: "btc",
        after,
      }),
    from,
    now,
    (t) => {
      const time = Math.floor(t.t / TF) * TF;
      let fp = fps.get(time);
      if (!fp) fps.set(time, (fp = emptyFootprint(time, step!)));
      addTrade(fp, t.p, t.s, t.buy, t.t);
      touched.add(time);
    },
    () => {},
    4,
    400,
  );
  if (!ok) {
    // Too many trades to catch up: start again from now.
    await sql`update fadebot_state5 set flow_until = ${now}, flow_from = ${now} where id = 1`;
    return;
  }
  for (const t of touched) {
    await sql`insert into fadebot_flow (time, fp) values (${t}, ${sql.json(fps.get(t)! as unknown as Parameters<typeof sql.json>[0])})
      on conflict (time) do update set fp = excluded.fp`;
  }
  await sql`update fadebot_state5 set flow_until = ${now}, flow_from = ${gap ? from : st.flow_from ?? from} where id = 1`;
  await sql`delete from fadebot_flow where time < ${Math.floor(now - 2 * 86400)}`;
}

/** Stored footprints that are complete (inside the continuous stretch), by candle time. */
async function footprintsFrom(since: number): Promise<Map<number, Footprint>> {
  const sql = db();
  const st = (await sql`select flow_from from fadebot_state5 where id = 1`)[0];
  const okFrom = st?.flow_from ? Math.ceil(Number(st.flow_from) / TF) * TF : Infinity;
  const out = new Map<number, Footprint>();
  for (const r of await sql`select time, fp from fadebot_flow where time >= ${Math.max(since, okFrom)}`) {
    out.set(Number(r.time), r.fp as Footprint);
  }
  return out;
}

/** Bitcoin volume per candle (Coinbase), like the website's context. */
async function volumes(from: number, to: number): Promise<Map<number, number> | undefined> {
  try {
    const r = await gold<{ volume: { time: number; volume: number }[] }>({ action: "volume", market: "btc", from, to, granularity: TF });
    return new Map(r.volume.map((v) => [v.time, v.volume]));
  } catch {
    return undefined;
  }
}

// ── Polymarket price history per window ───────────────────────────────
// gateway.polymarket.us GET /v1/price-history?symbol=<market slug>&fidelity=1&fixedInterval=… gives about one point
// a minute of the Yes display price (longPrice, from the best ask = the cost to buy Yes) and the No display price
// (shortPrice, 1 − best bid = the cost to buy No). Display prices, not trades.

const GATEWAY = env("PM_GATEWAY_URL") || "https://gateway.polymarket.us";

const num = (v: unknown): number | null => {
  const x = typeof v === "object" && v !== null ? (v as { value?: unknown }).value : v;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const toSec = (v: unknown): number | null => {
  if (typeof v === "string" && !/^\d+(\.\d+)?$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t / 1000 : null;
  }
  const n = num(v);
  return n === null ? null : n > 1e11 ? n / 1000 : n;
};

/** Points {t, yes, no} from a price-history response, whatever the exact shape (first array of price objects). */
function historyPoints(j: unknown): { t: number; yes: number | null; no: number | null }[] {
  const seen = new Set<unknown>();
  const find = (x: unknown): Record<string, unknown>[] | null => {
    if (!x || typeof x !== "object" || seen.has(x)) return null;
    seen.add(x);
    if (Array.isArray(x)) {
      if (x.some((e) => e && typeof e === "object" && ("longPrice" in e || "shortPrice" in e))) return x as Record<string, unknown>[];
      for (const e of x) {
        const f = find(e);
        if (f) return f;
      }
      return null;
    }
    for (const v of Object.values(x as Record<string, unknown>)) {
      const f = find(v);
      if (f) return f;
    }
    return null;
  };
  const arr = find(j) ?? [];
  const out: { t: number; yes: number | null; no: number | null }[] = [];
  for (const e of arr) {
    const t = toSec(e.t ?? e.ts ?? e.time ?? e.timestamp ?? e.createTime ?? e.updateTime ?? e.date);
    if (t === null) continue;
    out.push({ t, yes: num(e.longPrice), no: num(e.shortPrice) });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function priceHistory(slug: string): Promise<{ pts: ReturnType<typeof historyPoints>; sample: string }> {
  let last = "";
  for (const fixedInterval of ["INTERVAL_6H", "INTERVAL_1D", "INTERVAL_LIVE"]) {
    const q = new URLSearchParams({ symbol: slug, fidelity: "1", fixedInterval });
    const res = await fetch(`${GATEWAY}/v1/price-history?${q}`, { headers: { Accept: "application/json" } });
    const text = await res.text();
    last = `${fixedInterval} ${res.status}: ${text.slice(0, 300)}`;
    if (!res.ok) continue;
    let j: unknown = null;
    try {
      j = JSON.parse(text);
    } catch {
      continue;
    }
    const pts = historyPoints(j);
    if (pts.length) return { pts, sample: `${fixedInterval}: ${text.slice(0, 300)}` };
  }
  return { pts: [], sample: last };
}

/** Fill in the price history for finished windows (the scheduled run, a batch at a time, last 6 hours). */
async function updatePmHistory(now: number) {
  const sql = db();
  const last = Math.floor(now / TF) * TF - TF; // the newest finished window (ended at least a few seconds ago)
  const done = new Set(
    (await sql`select window_start from fadebot_pmhist where window_start > ${last - 72 * TF} and (n_points > 0 or fetched_at > now() - interval '30 minutes')`).map(
      (r) => Number(r.window_start),
    ),
  );
  let budget = 24;
  for (let ws = last - TF; ws > last - 72 * TF && budget > 0; ws -= TF) {
    // (the window that just ended is left for the next run, so its last minute is in the history)
    if (done.has(ws)) continue;
    budget -= 1;
    let row: Record<string, unknown> = { window_start: ws, n_points: 0 };
    try {
      const r = await pm().events.retrieveBySlug(`btc-updown-5m-${slugTime(ws)}`).catch(() => null);
      const ev = (r as { event?: Ev } | null)?.event;
      const mk = ev ? (await marketsOf(ev))[0] : undefined;
      if (!mk) {
        row.error = "no market for this window";
      } else {
        const ls = longSide(mk);
        const longIs: Side = ls?.side ?? "up";
        const { pts, sample } = await priceHistory(mk.slug);
        const inWin = pts.filter((p) => p.t >= ws && p.t <= ws + TF);
        const up = (p: (typeof pts)[number]) => (longIs === "up" ? p.yes : p.no);
        const down = (p: (typeof pts)[number]) => (longIs === "up" ? p.no : p.yes);
        const low = (f: (p: (typeof pts)[number]) => number | null) => {
          const v = inWin.map(f).filter((x): x is number => x !== null);
          return v.length ? Math.min(...v) : null;
        };
        // The price around the bot's read: the latest point at or before it, else the first in the window.
        const atRead = [...inWin].reverse().find((p) => p.t <= ws + READ_AT) ?? inWin[0];
        row = {
          window_start: ws,
          slug: mk.slug,
          long_is: ls ? longIs : "up?",
          up_low: low(up),
          down_low: low(down),
          up_read: atRead ? up(atRead) : null,
          down_read: atRead ? down(atRead) : null,
          n_points: inWin.length,
          error: inWin.length ? null : pts.length ? "no points inside the window" : "no price history",
          sample: inWin.length ? null : sample,
        };
      }
    } catch (e) {
      row.error = (e as Error).message.slice(0, 200);
    }
    await sql`insert into fadebot_pmhist ${sql(row)} on conflict (window_start) do update set
      slug = excluded.slug, long_is = excluded.long_is, up_low = excluded.up_low, down_low = excluded.down_low,
      up_read = excluded.up_read, down_read = excluded.down_read, n_points = excluded.n_points,
      error = excluded.error, sample = excluded.sample, fetched_at = now()`;
  }
  await sql`delete from fadebot_pmhist where window_start < ${Math.floor(now - 3 * 86400)}`;
}

// ── The TradingView indicator on 15-minute candles ───────────────────

/**
 * The chart's Fast/Slow EMAs (the TV indicator's 9/21) at the read: run over the closed candles plus the forming
 * candle at its current price, exactly as the chart draws the live EMA lines.
 */
async function emasAt(tfMin: number, closed5: Candle[], forming5: Candle): Promise<{ fast: number | null; slow: number | null }> {
  let closed = closed5;
  let forming = forming5;
  if (tfMin === 15) {
    const now = Date.now() / 1000;
    const r = await gold<{ candles: Candle[] }>({
      action: "history",
      market: "btc",
      resolution: 15,
      from: Math.floor(now - 3000 * 900 * 1.7),
      to: Math.floor(now),
    });
    closed = r.candles.filter((c) => c.time + 900 <= now).sort((a, b) => a.time - b.time).slice(-3000);
    const t = Math.floor(forming5.time / 900) * 900;
    forming = { time: t, open: forming5.open, high: forming5.high, low: forming5.low, close: forming5.close };
  }
  const tv = runTvIndicator(closed.slice(-3000), forming);
  return { fast: tv.live?.emaFast ?? null, slow: tv.live?.emaSlow ?? null };
}

// ── Regime: Jev's recent record at the read ─────────────────────────

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

/** READ_AT seconds into window `start`: ask Jev; if its call is 50–90% sure, a $1 market order on the other side. */
async function decideWindow(start: number) {
  const sql = db();
  if ((await sql`select 1 from fadebot_bets5 where window_start = ${start}`).length) return;
  const cfg = settings();
  const before = await period(start - 60);
  if (!before || before.n < 20) return skip(start, "no price to beat (the minute before the window wasn't recorded)");
  // The candle so far, built the way the website builds it from BRTI ticks: it opens at the last price before the
  // window (the previous candle's close); high/low/close come from the ticks since. Polymarket's price to beat (the
  // average of the minute before) is kept separately for settling.
  const offsets = Array.from({ length: READ_MIN }, (_, i) => i * 60);
  const mins = (await Promise.all(offsets.map((o) => period(start + o)))).filter(
    (x): x is NonNullable<typeof x> => !!x && x.n >= 3,
  );
  const last = await period(start + (READ_MIN - 1) * 60);
  if (!last || last.n < 3) return skip(start, `no prices recorded before the ${READ_AT}-second read`);
  const openRef = before.avg;
  const pageOpen = before.last;
  const forming: Candle = {
    time: start,
    open: pageOpen,
    high: Math.max(...mins.map((x) => x.high)),
    low: Math.min(...mins.map((x) => x.low)),
    close: last.last,
  };
  const closed = await closedCandles(start, 8);
  const atrs = atrByTime(closed.slice(Math.max(0, closed.length - 700)));
  const atr = atrs.get(start - TF) ?? null;
  const sd = bodySd(closed);
  if (!atr || !sd) return skip(start, "not enough candle history");
  const state = flipState({ forming, secondsLeft: TF - READ_AT, tfSeconds: TF, atr, sd, previous: closed.slice(-15) });
  if (!state) return skip(start, "price exactly at the candle's open");
  // The website's extras: market context, recent order flow, and this candle's order flow so far.
  await updateFlow(Date.now() / 1000, atr).catch((e) => console.error("order flow:", (e as Error).message));
  const fps = await footprintsFrom(start - 25 * TF).catch(() => new Map<number, Footprint>());
  const ctx = marketContext({
    closed,
    forTime: start,
    tfSeconds: TF,
    atr,
    market: "btc",
    volume: await volumes(start - 30 * TF, start),
  });
  const recentFlow = flowContext(closed, fps, start, TF, atr);
  const nowFlow = flowSoFar(
    fps.get(start),
    READ_AT,
    [1, 2, 3, 4, 5, 6].map((k) => fps.get(start - k * TF)),
  );
  const extras = {
    ...(ctx ? { market_context: ctx } : {}),
    ...(recentFlow ? { order_flow_recent_candles: recentFlow } : {}),
    ...(nowFlow ? { order_flow_this_candle_so_far: nowFlow } : {}),
  };
  // The TV indicator, as the website sends it (EMAs live at the current price).
  const tvc = tvContext(closed, start, TF, forming.close);
  if (tvc) (extras as Record<string, unknown>).tv_indicator = tvc;
  // Same request key as the website's "Jev at minute N": if both ask within a minute, they share one answer.
  const { pFlip } = await gold<{ pFlip: number }>({
    action: "flip",
    market: "btc",
    timeframeMin: 5,
    state: { ...state, ...extras },
    slotKey: `v2:m${READ_AT / 60}:${start}`,
  });
  const move = forming.close - forming.open;
  const pGreen = greenFromFlip(move, pFlip);
  await sql`insert into fadebot_reads5 (window_start, p_green, move, open_ref) values (${start}, ${pGreen}, ${move}, ${openRef})
    on conflict (window_start) do nothing`;
  // Regime is only shown for reference now (Jev's recent record at the read); it doesn't change the bet.
  const reg = regimeOf(await jevHits(start), start, TF);
  const regLabel = `${reg.regime === "normal" ? "Jev right" : reg.regime === "backwards" ? "Jev backwards" : "unclear"} (${reg.right}/${reg.n})`;
  const jevSide = pGreen > 0.5 ? "up" : "down";
  const jevSure = Math.round(Math.max(pGreen, 1 - pGreen) * 100);
  const jevKind = move === 0 || (pGreen > 0.5) === move > 0 ? "holds" : "flip";
  // The EMA rule: bet with Jev's call (hold or flip) only when the EMAs agree (fast over slow for up, under for down).
  let ema: { fast: number | null; slow: number | null } = { fast: null, slow: null };
  try {
    ema = await emasAt(cfg.emaTf, closed, forming);
  } catch (e) {
    console.error("EMAs:", (e as Error).message);
  }
  const fmt = (v: number | null) => (v === null ? "?" : v.toFixed(2));
  const tvLabel = `${cfg.emaTf}m EMA fast ${fmt(ema.fast)} ${
    ema.fast === null || ema.slow === null ? "vs" : ema.fast > ema.slow ? ">" : ema.fast < ema.slow ? "<" : "="
  } slow ${fmt(ema.slow)}`;
  const jevTxt = `Jev: ${jevKind} → ${jevSide} (${jevSure}%)`;
  // The last closed candle's color (for the close-EMAs rule), as the chart shows it.
  const prev = closed[closed.length - 1];
  const lastColor: Side | null =
    !prev || prev.time !== start - TF ? null : prev.close > prev.open ? "up" : prev.close < prev.open ? "down" : null;
  const dd = emaRuleDecision(pGreen, move, ema.fast, ema.slow, cfg.emaGap, lastColor);
  if ("skip" in dd) {
    await skip(start, `${jevTxt}; ${tvLabel}: ${dd.skip}: no bet`);
    await sql`update fadebot_bets5 set regime = ${regLabel}, tv15 = ${tvLabel} where window_start = ${start}`;
    return;
  }
  const d = dd;
  // Flip trades only while Jev has been right lately (regime "Jev right"); not when unclear or backwards.
  if (cfg.flipNeedsRegime && d.kind === "flip-ema" && reg.regime !== "normal") {
    await skip(start, `${jevTxt}; ${tvLabel}; flip call but regime is ${regLabel}: no bet`);
    await sql`update fadebot_bets5 set regime = ${regLabel}, tv15 = ${tvLabel} where window_start = ${start}`;
    return;
  }

  const stake = cfg.marketBet;
  const market = await findMarket(start).catch(() => null);
  if (!market) {
    const call = `Jev: ${jevKind} → ${jevSide} (${jevSure}%), bet ${d.side}`;
    await skip(start, `${call}, but no Polymarket 5-minute market found for this window (${lastSearch})`.slice(0, 700));
    await sql`update fadebot_bets5 set regime = ${regLabel}, kind = ${d.kind} where window_start = ${start}`;
    return;
  }

  // Never bet when real settlements contradict the YES side. Not yet confirmed (nothing settled to check) → bet on
  // the market's own settle rule, and note it on the bet.
  const chk = await checkLong(start, market.longIs).catch((e) => ({ ok: null, note: (e as Error).message }));
  if (chk.ok === false) {
    await skip(start, `Jev: ${d.kind} → ${d.side}; market ${market.slug} found (YES = ${market.longIs}, ${lastHow}) but ${chk.note}`.slice(0, 700));
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
        if (!(cfg.limitShares > 0)) return skip(start, `market order failed: ${(e as Error).message}`.slice(0, 300));
        console.error("market order failed:", (e as Error).message);
      }
    }
    if (cfg.limitShares > 0) {
      try {
        limitId = await limitBuy(market, d.side, cfg.limitPrice, cfg.limitShares, start + TF);
      } catch (e) {
        if (!shares) return skip(start, `limit order failed: ${(e as Error).message}`.slice(0, 300));
        console.error("limit order failed:", (e as Error).message);
      }
    }
  } else if (stake > 0 && price && price > 0) shares = stake / price;
  await sql`insert into fadebot_bets5 (window_start, mode, status, market_slug, long_is, jev_sure, side, step, stake, price, shares, fees,
      limit_order_id, limit_price, limit_shares, limit_filled, open_ref, order_id, regime, kind, reason, tv15)
    values (${start}, ${cfg.mode}, 'open', ${market.slug}, ${market.longIs}, ${d.sure}, ${d.side}, 0, ${stake}, ${price ?? 0},
      ${shares}, ${fees}, ${limitId}, ${cfg.limitPrice}, ${cfg.limitShares}, 0, ${openRef}, ${orderId}, ${regLabel}, ${d.kind},
      ${chk.ok ? null : `YES = ${market.longIs} from the ${lastHow}; ${chk.note}`.slice(0, 700)}, ${tvLabel})
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
    const next = start + TF;
    if (EARLY) {
      // Keep recording into the next window up to the read, then make the next window's call from here.
      const { ticks, source } = await record(next + READ_AT);
      await savePeriod(from, from + 60, ticks.filter((t) => t.t < next), source);
      await savePeriod(next, next + 60, ticks.filter((t) => t.t >= next), source);
      done.push(`recorded the price to beat and the next window's first ${READ_AT} s (${ticks.length} ticks from ${source})`);
      await decideWindow(next).catch((e) => skip(next, `error: ${(e as Error).message}`.slice(0, 300)));
      done.push("decided the next window");
    } else {
      const { ticks, source } = await record(from + 58);
      await savePeriod(from, from + 60, ticks, source);
      done.push(`recorded the price to beat (${ticks.length} ticks from ${source})`);
      await updateFlow(Date.now() / 1000, null).catch(() => {});
    }
  } else if (!EARLY && m < READ_MIN) {
    // The minutes before the read, then (READ_AT seconds in) Jev's read and the bet.
    const from = start + m * 60;
    const last = m === READ_MIN - 1;
    const until = last ? start + READ_AT : from + 58;
    const { ticks, source } = await record(until);
    await savePeriod(from, from + 60, ticks, source);
    done.push(`recorded minute ${m + 1} (${ticks.length} ticks from ${source})`);
    if (!last) await updateFlow(Date.now() / 1000, null).catch(() => {});
    if (last) {
      await decideWindow(start).catch((e) => skip(start, `error: ${(e as Error).message}`.slice(0, 300)));
      done.push("decided");
    }
  }
  await settle();
  await db()`delete from fadebot_prices where period_start < ${Math.floor(now - 3 * 86400)}`;
  if (m >= READ_MIN && m <= 3) {
    if (m === 3) await jevHits(Math.floor(now)).catch(() => []); // keep outcomes filled in for the page
    if (m === 3) await updatePmHistory(now).catch((e) => console.error("price history:", (e as Error).message));
    // First run: work out the footprint step from the ATR, then keep the order flow current.
    const st = (await db()`select flow_step from fadebot_state5 where id = 1`)[0];
    let atr: number | null = null;
    if (!st?.flow_step) {
      const closed = await closedCandles(start, 2).catch(() => []);
      atr = atrByTime(closed).get(closed[closed.length - 1]?.time) ?? null;
    }
    await updateFlow(Date.now() / 1000, atr).catch((e) => console.error("order flow:", (e as Error).message));
  }
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
    // Polymarket's prices per window (last 6 hours), with how the window ended (BRTI, Polymarket's rule).
    pmHistory: await db()`select h.window_start, h.up_low, h.down_low, h.up_read, h.down_read, h.n_points, h.long_is,
        h.error, h.sample, r.outcome from fadebot_pmhist h left join fadebot_reads5 r on r.window_start = h.window_start
        where h.window_start > ${now - 6 * 3600} order by h.window_start desc`.catch(() => []),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "status") return json(await status());
    if (body?.action === "read") {
      // Read-only: the bot's Jev read for one window, so the page shows the same call the bot bets on.
      const w = Math.floor(Number(body.window));
      const r = await db()`select window_start, p_green, move, open_ref from fadebot_reads5 where window_start = ${w}`.catch(
        () => [],
      );
      return json({ read: r[0] ?? null, readAt: READ_AT });
    }
    if (body?.action === "find-market") {
      // Read-only: which Polymarket market the bot would trade for the current window.
      const start = Math.floor(Date.now() / 1000 / TF) * TF;
      lastMarket = null;
      lastHow = "";
      const m = await findMarket(start);
      const check = m ? await checkLong(start, m.longIs).catch((e) => ({ ok: null, note: (e as Error).message })) : null;
      return json({
        check,
        window: new Date(start * 1000).toISOString(),
        market: m,
        search: lastSearch,
        how: lastHow,
        record: JSON.stringify(lastMarket ?? null).slice(0, 4000),
      });
    }
    const authFailure = authenticateCronRequest(req);
    if (authFailure) return authFailure;
    // Test hook (only with FADEBOT_ALLOW_TEST=1, never set in production): decide the current window now.
    if (body?.action === "test-pmhist" && env("FADEBOT_ALLOW_TEST") === "1") {
      await setup();
      await updatePmHistory(Date.now() / 1000);
      return json(await status());
    }
    if (body?.action === "test-decide" && env("FADEBOT_ALLOW_TEST") === "1") {
      await setup();
      const start = Math.floor(Date.now() / 1000 / TF) * TF;
      const { ticks, source } = await record(Date.now() / 1000 + 5);
      for (let o = 0; o < READ_AT; o += 60) await savePeriod(start + o, start + o + 60, ticks.map((t) => ({ ...t, t: start + o + 1 })), source);
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
