// Polymarket US bot for "BTC Up or Down: 5 min", run by a schedule every minute (pg_cron).
//
// FADEBOT_STRATEGY = longshot: in the last FADEBOT_LONGSHOT_WINDOW_SEC (90) of each window, work out the settlement
//   (BRTI average over the final minute vs the minute before the start; _shared/longshot.ts) and buy only a side at
//   99.5%+ costing 85–99¢ with a 1-point margin, all-in (capped by book depth), held to settlement; tracks the win
//   streak toward FADEBOT_LONGSHOT_GOAL (45) and logs every call (fadebot_longshot). Real orders only with
//   FADEBOT_MODE=live AND FADEBOT_LONGSHOT_LIVE=1.
// FADEBOT_STRATEGY = jev-trader (the default): Jev is asked over and over all through each window (a new question as
//   soon as the last answer is in, FADEBOT_TRADER_GAP_SEC apart at least) with the candle, Lightspeed, candle strength,
//   the live market block, Polymarket's buy/sell prices and our position: flat → buy Up / buy Down / wait; holding →
//   sell / hold. Buys need Jev's chance to beat the cost by FADEBOT_TRADER_EDGE points (5) and are sized by Kelly
//   (_shared/fadeStrategy.ts traderDecision); sells are market orders; anything unsold settles. Every ask is logged
//   (fadebot_asks) to measure whether Jev beats the price. Real orders only with FADEBOT_MODE=live AND
//   FADEBOT_TRADER_LIVE=1.
// FADEBOT_STRATEGY = lightspeed: the Lightspeed fade. Minutes 0–1 of each window, the bot watches every
//   BRTI tick; when the candle's move so far (from the website's candle open) gets bigger than Lightspeed's typical move
//   in the time left (FADEBOT_LS_WINDOW_SEC, default the first 120 s), it market-buys $1 (FADEBOT_LS_BET) of the
//   opposite side. Every run then checks the bid every 2 s and market-sells the whole position once it's worth
//   FADEBOT_TAKE_PROFIT × the buy price (default 2 = 100% profit); otherwise it's held to settlement. Jev isn't asked.
//   Candle strength (_shared/candleStrength.ts, 0–100 from momentum, range position, trade flow, books, ETH/SOL)
//   decides: a big move that's FADEBOT_STRONG_MIN (60)+ strong the same way is bought WITH instead of faded, and any
//   candle that strong between FADEBOT_STRONG_FROM_SEC (60) and FADEBOT_STRONG_TO_SEC (240) is bought WITH for
//   FADEBOT_STRONG_BET ($5), held to settlement. Strength is also logged at 60/120/180/240 s of every window.
//   FADEBOT_STRATEGY = jev-ema: the older rule below.
//
// Each 5-minute window [S, S+300):
//   minute 4 of the previous window (S−60 … S): record BRTI → the "price to beat" (60-second average)
//   S … S+READ: record BRTI, then (FADEBOT_READ_SEC: 30, 60, 120 or 180 seconds in, default 30) ask Jev whether the candle ends green or red, with
//     exactly the website's "Jev at minute N" question: the candle as the website builds it, the last 40 candles,
//     market context and Coinbase order flow (kept current every minute), and the same request key, so the two
//     share one answer when they ask within a minute.
//     The EMA rule, at that read:
//       bet WITH Jev's call (hold or flip) only when the EMAs agree with it:
//       Jev calls up and the fast EMA (9) is above the slow EMA (21) → bet up
//       Jev calls down and the fast EMA is below the slow EMA → bet down
//       …and only when the EMAs are at least $30 apart (FADEBOT_EMA_GAP); otherwise no bet.
//       Flip calls also need the regime to be "Jev right" (FADEBOT_FLIP_REGIME=off to drop that).
//     EMAs under $30 apart: a HOLD call the same color as the last closed candle, with the EMAs pointing against
//       Jev → bet AGAINST Jev (the EMAs' side); a FLIP call with the EMAs pointing Jev's way and the last candle the
//       other color → bet WITH Jev. Else no bet. (No regime check.) Any confidence over 50%. EMAs: the chart's live lines (FADEBOT_EMA_TF 5 or 15 minutes).
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
  lightspeedDecision,
  takeProfitPrice,
  traderDecision,
  trendFlipSide,
  trendSummary,
  type TraderCfg,
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
import { lightspeedCore } from "../_shared/lightspeedCore.ts";
import { lightspeedLive } from "../_shared/lightspeedLive.ts";
import { candleStrength } from "../_shared/candleStrength.ts";
import { askJevTrader } from "../_shared/jevTrader.ts";
import { depthDollars, type LongshotCfg, longshotDecision, settleProbability } from "../_shared/longshot.ts";

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
  emaGap: Number(env("FADEBOT_EMA_GAP") || 30),
  // Flip trades only in the "Jev right" regime (Jev right on more than half of its last 12 reads); off = any regime.
  flipNeedsRegime: env("FADEBOT_FLIP_REGIME") !== "off",
  readAt: READ_AT,
  // Which rule bets: "lightspeed" (default) = the Lightspeed fade with market orders; "jev-ema" = the old Jev + EMA
  // limit orders.
  strategy: (["jev-ema", "lightspeed", "longshot"].includes(env("FADEBOT_STRATEGY"))
    ? env("FADEBOT_STRATEGY")
    : "jev-trader") as "jev-trader" | "lightspeed" | "jev-ema" | "longshot",
  // Longshot (FADEBOT_STRATEGY=longshot): near-certain sides only, late, 85–99¢, all-in, aiming for a run of wins.
  // Real orders only with FADEBOT_MODE=live AND FADEBOT_LONGSHOT_LIVE=1.
  longshot: {
    live: env("FADEBOT_LONGSHOT_LIVE") === "1",
    minCost: Number(env("FADEBOT_LONGSHOT_MIN") || 85) / 100,
    maxCost: Number(env("FADEBOT_LONGSHOT_MAX") || 99) / 100,
    minProb: Number(env("FADEBOT_LONGSHOT_MIN_PROB") || 99.5) / 100,
    margin: Number(env("FADEBOT_LONGSHOT_MARGIN") || 1) / 100,
    feePerShare: Number(env("FADEBOT_LONGSHOT_FEE_CENTS") || 0) / 100,
    windowSec: Number(env("FADEBOT_LONGSHOT_WINDOW_SEC") || 90),
    stopSec: Number(env("FADEBOT_LONGSHOT_STOP_SEC") || 3),
    safety: Number(env("FADEBOT_LONGSHOT_SAFETY") || 1.5),
    feedSd: Number(env("FADEBOT_LONGSHOT_FEED_SD") || 3),
    allIn: env("FADEBOT_LONGSHOT_ALL_IN") !== "0",
    bet: Number(env("FADEBOT_LONGSHOT_BET") || 10),
    bankroll: Number(env("FADEBOT_LONGSHOT_BANKROLL") || 100),
    slipCents: Number(env("FADEBOT_LONGSHOT_SLIP_CENTS") || 1),
    goal: Number(env("FADEBOT_LONGSHOT_GOAL") || 45),
  },
  // Jev trader: Jev is asked over and over (a new question as soon as the last answer is in) whether to buy Up, buy
  // Down or wait — or, holding, whether to sell. Real orders only with FADEBOT_MODE=live AND FADEBOT_TRADER_LIVE=1.
  trader: {
    live: env("FADEBOT_TRADER_LIVE") === "1",
    edge: Number(env("FADEBOT_TRADER_EDGE") || 5) / 100, //  points Jev's chance must beat the cost by
    bankroll: Number(env("FADEBOT_TRADER_BANKROLL") || 100),
    kelly: Number(env("FADEBOT_TRADER_KELLY") || 0.25),
    maxBet: Number(env("FADEBOT_TRADER_MAX_BET") || 10),
    minBet: Number(env("FADEBOT_TRADER_MIN_BET") || 1),
    dailyLoss: Number(env("FADEBOT_TRADER_DAILY_LOSS") || 25),
    minLeftSec: Number(env("FADEBOT_TRADER_MIN_LEFT_SEC") || 10),
    maxEntries: Number(env("FADEBOT_TRADER_MAX_ENTRIES") || 3),
    gapSec: Number(env("FADEBOT_TRADER_GAP_SEC") || 2),
    // Selling early (Jev asked "sell or hold?" while holding) is off: positions are held to settlement.
    // FADEBOT_TRADER_SELL=1 turns Jev's sell decisions back on.
    sell: env("FADEBOT_TRADER_SELL") === "1",
    // Fade Jev: when Jev's buy passes the checks, buy the OTHER side instead (same dollar amount).
    // Off (Nov 8); FADEBOT_TRADER_INVERT=1 turns it on.
    invert: env("FADEBOT_TRADER_INVERT") === "1",
    // All-in (FADEBOT_TRADER_ALL_IN=1): every buy uses the whole available balance (less a 3% buffer for fees) instead of
    // the edge-based size; one loss empties the account. Live: Polymarket buying power; test: bankroll + test P&L.
    allIn: env("FADEBOT_TRADER_ALL_IN") === "1",
    // No buys when the side costs between these (cents, inclusive). Off since Nov 8; FADEBOT_TRADER_BAN=on turns it on.
    banLo: env("FADEBOT_TRADER_BAN") === "on" ? Number(env("FADEBOT_TRADER_BAN_MIN") || 45) / 100 : undefined,
    banHi: env("FADEBOT_TRADER_BAN") === "on" ? Number(env("FADEBOT_TRADER_BAN_MAX") || 60) / 100 : undefined,
    // What triggers a buy: "probability" (default, Nov 8) = Jev's more-likely side whenever Jev's chance beats its
    // price by the edge, whatever Jev's buy/wait choice; FADEBOT_TRADER_TRIGGER=choice = only when Jev says buy.
    trigger: (env("FADEBOT_TRADER_TRIGGER") === "choice" ? "choice" : "probability") as "choice" | "probability",
    // How it buys: "limit" (default, Nov 8) = a limit order for FADEBOT_TRADER_LIMIT_SHARES (15) at
    // FADEBOT_TRADER_LIMIT_PRICE (33¢) on the picked side, good until the window ends (the edge is measured against
    // what it would pay: 33¢, or less if the side is already cheaper); FADEBOT_TRADER_ORDER=market = a market buy.
    // "flip" (default, Nov 9): once Jev's pick triggers, buy nothing yet — wait for the OTHER side to reach
    // FADEBOT_TRADER_FLIP_AT (60¢), then market-buy FADEBOT_TRADER_FLIP_BET dollars ($5) of that other side, as long as
    // it costs no more than FADEBOT_TRADER_FLIP_MAX (75¢); held to settlement.
    order: (["market", "limit"].includes(env("FADEBOT_TRADER_ORDER")) ? env("FADEBOT_TRADER_ORDER") : "flip") as
      | "market"
      | "limit"
      | "flip",
    flipAt: Number(env("FADEBOT_TRADER_FLIP_AT") || 60) / 100,
    flipMax: Number(env("FADEBOT_TRADER_FLIP_MAX") || 75) / 100,
    flipBet: Number(env("FADEBOT_TRADER_FLIP_BET") || 5),
    // Flip buys sized as a % of the balance (live: Polymarket buying power; test: bankroll + test P&L), default 10%;
    // FADEBOT_TRADER_BET_PCT=0 goes back to the fixed FADEBOT_TRADER_FLIP_BET. Never under $1.
    betPct: env("FADEBOT_TRADER_BET_PCT") === "" ? 10 : Number(env("FADEBOT_TRADER_BET_PCT")) || 0,
    // Trend-aware flip (Nov 12): if, when Jev's call comes in, the side the flip would buy is already at 60¢+ and it's
    // against the trend (Up already high in a downtrend), watch the trend's side instead and buy it once it reaches
    // 60¢ (mirror in an uptrend). A later cross of 60¢ buys as before. FADEBOT_TRADER_TREND=off = the old flip.
    trend: env("FADEBOT_TRADER_TREND") !== "off",
    limitPrice: Number(env("FADEBOT_TRADER_LIMIT_PRICE") || 33) / 100,
    limitShares: Number(env("FADEBOT_TRADER_LIMIT_SHARES") || 15),
    // Limit mode: when the side already costs less than the limit, buy FADEBOT_TRADER_CHEAP_BET dollars ($1) at market
    // instead of placing the limit order.
    cheapBet: Number(env("FADEBOT_TRADER_CHEAP_BET") || 1),
  },
  // Lightspeed fade: market buy of this many dollars, only in the first lsWindowSec seconds of the candle, sold with a
  // market order once the shares are worth takeProfit × what they cost (2 = 100% profit); otherwise held to settlement.
  lsBet: Number(env("FADEBOT_LS_BET") || 1),
  lsWindowSec: Number(env("FADEBOT_LS_WINDOW_SEC") || 120),
  // Fading big weak moves is off (removed Nov 7); FADEBOT_LS_FADE=1 turns it back on.
  lsFade: env("FADEBOT_LS_FADE") === "1",
  // Candle strength ("strength decides"): a big move that's strong the same way is bought WITH instead of faded, and
  // a strong candle is bought between strongFromSec and strongToSec; strength = 0–100 (_shared/candleStrength.ts).
  strongMin: Number(env("FADEBOT_STRONG_MIN") || 60),
  strongBet: Number(env("FADEBOT_STRONG_BET") || 5),
  strongFromSec: Number(env("FADEBOT_STRONG_FROM_SEC") || 60),
  strongToSec: Number(env("FADEBOT_STRONG_TO_SEC") || 240),
  takeProfit: Number(env("FADEBOT_TAKE_PROFIT") || 2),
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
  // Lightspeed fade: the take-profit target and the sale.
  await sql`alter table fadebot_bets5 add column if not exists target_price double precision`;
  await sql`alter table fadebot_bets5 add column if not exists exit_price double precision`;
  await sql`alter table fadebot_bets5 add column if not exists exit_order_id text`;
  await sql`alter table fadebot_bets5 add column if not exists exit_at timestamptz`;
  // Candle strength at fixed points of every window (60/120/180/240 s), to see how often strong candles finish their way.
  await sql`create table if not exists fadebot_strength (
    window_start bigint not null, at_sec int not null, score double precision not null, used text,
    move double precision, primary key (window_start, at_sec))`;
  // Jev trader: positions (one open per window at a time) and every question asked.
  await sql`create table if not exists fadebot_trades (
    id bigserial primary key, window_start bigint not null, mode text not null, status text not null default 'open',
    market_slug text, long_is text, side text not null, stake double precision, shares double precision,
    price double precision, fees double precision default 0, opened_sec double precision, p_side double precision,
    order_id text, open_ref double precision, exit_price double precision, exit_sec double precision,
    exit_order_id text, result text, pnl double precision, reason text, opened_at timestamptz default now(),
    closed_at timestamptz)`;
  await sql`create index if not exists fadebot_trades_window on fadebot_trades (window_start)`;
  await sql`create table if not exists fadebot_asks (
    id bigserial primary key, window_start bigint not null, at_sec double precision, p_up double precision,
    action text, probs jsonb, up_cost double precision, down_cost double precision, up_sell double precision,
    down_sell double precision, pos_side text, unrealized double precision, did text, ms int,
    created_at timestamptz default now())`;
  await sql`create index if not exists fadebot_asks_window on fadebot_asks (window_start)`;
  await sql`alter table fadebot_trades enable row level security`;
  // Which trader made the trade: 'trader' (Jev trader) or 'longshot'.
  await sql`alter table fadebot_trades add column if not exists strategy text default 'trader'`;
  // Limit orders: the order and how much of it has filled (shares/price then hold what actually filled).
  await sql`alter table fadebot_trades add column if not exists order_type text default 'market'`;
  await sql`alter table fadebot_trades add column if not exists limit_price double precision`;
  await sql`alter table fadebot_trades add column if not exists limit_shares double precision`;
  // Longshot: every window where its rule fired (bought or not), to check how often "near-certain" really wins.
  await sql`create table if not exists fadebot_longshot (
    window_start bigint primary key, at_sec double precision, side text, p double precision, cost double precision,
    bought boolean, note text, start_ref double precision, created_at timestamptz default now())`;
  await sql`alter table fadebot_longshot enable row level security`;
  await sql`create table if not exists fadebot_kv (k text primary key, v jsonb, at timestamptz default now())`;
  await sql`alter table fadebot_kv enable row level security`;
  await sql`alter table fadebot_asks enable row level security`;
  // Polymarket's own price history per 5-minute market: the lowest Up and Down prices during the window.
  await sql`create table if not exists fadebot_pmhist (
    window_start bigint primary key, slug text, long_is text, up_low double precision, down_low double precision,
    up_read double precision, down_read double precision, n_points int, error text, sample text,
    fetched_at timestamptz default now())`;
  await sql`alter table fadebot_pmhist enable row level security`;
  // Every price point inside the window, [seconds into the window, Up price, Down price], so the page can check
  // whether a limit order placed at any second would have filled.
  await sql`alter table fadebot_pmhist add column if not exists pts jsonb`;
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
async function record(
  until: number,
  onTick?: (t: number, p: number) => void,
): Promise<{ ticks: { t: number; p: number }[]; source: string }> {
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
          else if (typeof m.t === "number" && typeof m.p === "number") {
            ticks.push({ t: m.t, p: m.p });
            onTick?.(m.t, m.p);
          }
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
type Px = { value: string };
// deno-lint-ignore no-explicit-any
const pxOf = (v: any): Px | undefined => {
  const x = v && typeof v === "object" ? (v.value ?? v.px?.value ?? v.px) : v;
  const n = Number(x);
  return x !== undefined && x !== null && x !== "" && Number.isFinite(n) ? { value: String(n) } : undefined;
};
/** Which source last gave prices (shown in the ask log when it isn't the BBO). */
let lastQuoteVia = "";
/**
 * Best bid/ask (YES side). Tries the BBO (prices nested under `marketData`), then the full book, then the market
 * record itself, since the BBO has answered "market not found" for these 5-minute markets.
 */
async function bbo(slug: string): Promise<{ bestBid?: Px; bestAsk?: Px }> {
  const errs: string[] = [];
  const client = pm();
  try {
    // deno-lint-ignore no-explicit-any
    const r = (await client.markets.bbo(slug)) as any;
    const d = r?.marketData ?? r?.marketDataLite ?? r ?? {};
    const out = { bestBid: pxOf(d.bestBid), bestAsk: pxOf(d.bestAsk) };
    if (out.bestBid || out.bestAsk) {
      lastQuoteVia = "bbo";
      return out;
    }
    errs.push("bbo: no prices");
  } catch (e) {
    errs.push(`bbo: ${(e as Error).message}`);
  }
  try {
    // deno-lint-ignore no-explicit-any
    const r = (await client.markets.book(slug)) as any;
    const d = r?.marketData ?? r ?? {};
    // deno-lint-ignore no-explicit-any
    const top = (xs: any[] | undefined, best: (a: number, b: number) => number) =>
      (xs ?? []).map((l) => Number(l?.px?.value ?? l?.px ?? l?.price)).filter((n) => Number.isFinite(n)).sort(best)[0];
    const bid = top(d.bids, (a, b) => b - a);
    const ask = top(d.offers ?? d.asks, (a, b) => a - b);
    if (bid !== undefined || ask !== undefined) {
      lastQuoteVia = "book";
      return { bestBid: pxOf(bid), bestAsk: pxOf(ask) };
    }
    errs.push("book: no levels");
  } catch (e) {
    errs.push(`book: ${(e as Error).message}`);
  }
  try {
    // deno-lint-ignore no-explicit-any
    const r = (await client.markets.retrieveBySlug(slug)) as any;
    const m = r?.market ?? r ?? {};
    const out = { bestBid: pxOf(m.bestBid), bestAsk: pxOf(m.bestAsk) };
    if (out.bestBid || out.bestAsk) {
      lastQuoteVia = "market record";
      return out;
    }
    errs.push("market: no prices");
  } catch (e) {
    errs.push(`market: ${(e as Error).message}`);
  }
  throw new Error(`no prices for ${slug} (${errs.join("; ")})`);
}

async function priceFor(m: WindowMarket, side: Side): Promise<number | null> {
  const b = await bbo(m.slug);
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

/** What one share of `side` sells for now (0–1): YES sells at the best YES bid; NO at 1 − the best YES ask. */
async function sellPriceFor(m: WindowMarket, side: Side): Promise<number | null> {
  const b = await bbo(m.slug);
  if (side === m.longIs) return b.bestBid ? Number(b.bestBid.value) : null;
  return b.bestAsk ? Number((1 - Number(b.bestAsk.value)).toFixed(4)) : null;
}

/** Market-sell the whole position in this market. Returns the average price per share for our side. */
async function marketSellAll(m: WindowMarket, side: Side, expect: number) {
  const r = await pm().orders.closePosition({
    marketSlug: m.slug,
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
  let price = shares ? notional / shares : 0;
  // Fills may be reported in YES prices: for the NO side take whichever is closer to the price we saw.
  if (shares && side !== m.longIs && Math.abs(1 - price - expect) < Math.abs(price - expect)) price = 1 - price;
  return { id: r.id, shares, price, fees };
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

/** Fill in the price history for finished windows (the scheduled run, a batch at a time, last 24 hours). */
async function updatePmHistory(now: number) {
  const sql = db();
  const last = Math.floor(now / TF) * TF - TF; // the newest finished window (ended at least a few seconds ago)
  const done = new Set(
    (await sql`select window_start from fadebot_pmhist where window_start > ${last - 288 * TF}
      and ((n_points > 0 and pts is not null) or fetched_at > now() - interval '30 minutes')`).map(
      (r) => Number(r.window_start),
    ),
  );
  let budget = 30;
  for (let ws = last - TF; ws > last - 288 * TF && budget > 0; ws -= TF) {
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
          pts: sql.json(inWin.map((p) => [p.t - ws, up(p), down(p)])),
        };
      }
    } catch (e) {
      row.error = (e as Error).message.slice(0, 200);
    }
    await sql`insert into fadebot_pmhist ${sql(row)} on conflict (window_start) do update set
      slug = excluded.slug, long_is = excluded.long_is, up_low = excluded.up_low, down_low = excluded.down_low,
      up_read = excluded.up_read, down_read = excluded.down_read, n_points = excluded.n_points,
      error = excluded.error, sample = excluded.sample, pts = excluded.pts, fetched_at = now()`;
  }
  await sql`delete from fadebot_pmhist where window_start < ${Math.floor(now - 7 * 86400)}`;
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
  const state = flipState({ forming, secondsLeft: TF - READ_AT, tfSeconds: TF, atr, sd, previous: closed.slice(-40) });
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
  // Lightspeed V0.5 quant block, as the website sends it (the live market block is added by the gold function).
  const ls = lightspeedCore(closed, start, TF, READ_AT, forming);
  if (ls) (extras as Record<string, unknown>).lightspeed = ls;
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

// ── Lightspeed fade (FADEBOT_STRATEGY = lightspeed, the default) ───────

/** Book a closed trade's P&L into the running totals. */
async function bookResult(start: number, result: string, p: number, extra: { exit?: number; exitId?: string | null } = {}) {
  await db().begin(async (tx) => {
    const upd = await tx`update fadebot_bets5 set status = 'settled', result = ${result}, pnl = ${p}, settled_at = now(),
        exit_price = coalesce(${extra.exit ?? null}, exit_price), exit_order_id = coalesce(${extra.exitId ?? null}, exit_order_id),
        exit_at = case when ${extra.exit ?? null}::double precision is null then exit_at else now() end
      where window_start = ${start} and status = 'open' returning 1`;
    if (!upd.length) return;
    const st = (await tx`select * from fadebot_state5 where id = 1 for update`)[0];
    const total = st.total_pnl + p;
    const peak = Math.max(st.peak, total);
    await tx`update fadebot_state5 set step = 0, total_pnl = ${total}, peak = ${peak},
      worst_drawdown = ${Math.max(st.worst_drawdown, peak - total)}, trades = ${st.trades + 1},
      wins = ${st.wins + (p > 0 ? 1 : 0)} where id = 1`;
  });
}

/** Until `until`: every 2 s, market-sell any open Lightspeed bet whose shares are now worth its take-profit target. */
async function watchExits(until: number) {
  const sql = db();
  while (Date.now() / 1000 < until) {
    const now = Math.floor(Date.now() / 1000);
    const open = await sql`select * from fadebot_bets5 where status = 'open' and kind = 'ls-fade' and target_price is not null
      and shares > 0 and window_start + ${TF} > ${now}`.catch(() => []);
    if (!open.length) {
      // Nothing to watch yet: look again shortly (a bet may be placed by another run).
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const b of open) {
      const m = { slug: b.market_slug, longIs: b.long_is } as WindowMarket;
      const px = await sellPriceFor(m, b.side).catch(() => null);
      if (px === null || px < b.target_price) continue;
      const start = Number(b.window_start);
      try {
        let exit = px;
        let fees = Number(b.fees ?? 0);
        let exitId: string | null = null;
        let sold = Number(b.shares);
        if (b.mode === "live") {
          const f = await marketSellAll(m, b.side, px);
          if (!f.shares) continue; // nothing sold (no bids): try again
          exit = f.price;
          fees += f.fees;
          exitId = f.id;
          sold = Math.min(sold, f.shares);
        }
        const p = sold * (exit - Number(b.price)) - fees;
        await bookResult(start, "sold", p, { exit, exitId });
      } catch (e) {
        console.error("take-profit sale failed:", (e as Error).message);
        await sql`update fadebot_bets5 set reason = ${`take-profit sale failed: ${(e as Error).message}`.slice(0, 300)}
          where window_start = ${start}`;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Watch window `start` until `until` for the Lightspeed fade, recording this minute's BRTI as it goes. */
async function lightspeedWatch(start: number, minute: number, until: number) {
  const sql = db();
  const cfg = settings();
  const from = start + minute * 60;
  const before = await period(start - 60);
  const already = async () => (await sql`select 1 from fadebot_bets5 where window_start = ${start}`).length > 0;
  let done = await already();
  // The candle so far, built as the website builds it: open = the last price before the window.
  const forming: Candle | null = before
    ? { time: start, open: before.last, high: before.last, low: before.last, close: before.last }
    : null;
  for (let k = 0; forming && k < minute; k++) {
    const pm0 = await period(start + k * 60);
    if (pm0) {
      forming.high = Math.max(forming.high, pm0.high);
      forming.low = Math.min(forming.low, pm0.low);
      forming.close = pm0.last;
    }
  }
  const closed = !forming ? [] : await closedCandles(start, 4).catch(() => []);
  const market = done || !forming ? null : await findMarket(start).catch(() => null);
  const chk = market ? await checkLong(start, market.longIs).catch((e) => ({ ok: null, note: (e as Error).message })) : null;
  let best = { ratio: 0, move: 0, typical: 0, at: 0 };
  let bestStrength = 0;
  const rule = { fadeWindowSec: cfg.lsWindowSec, strongFromSec: cfg.strongFromSec, strongToSec: cfg.strongToSec, strongMin: cfg.strongMin, fade: cfg.lsFade };
  const watchEnd = Math.max(cfg.lsWindowSec, cfg.strongToSec);
  const marks = [60, 120, 180, 240].filter((x) => x > minute * 60 && x <= (minute + 1) * 60);
  // The live market block (books, trade flow, other coins) for the strength score, refreshed every 5 s.
  let liveNow: Record<string, unknown> | null = null;
  const liveLoop = (async () => {
    while (forming && Date.now() / 1000 < until) {
      liveNow = await lightspeedLive({ market: "btc", coinbase: "BTC-USD", tfSec: TF, forTime: start, open: forming.open })
        .catch(() => liveNow);
      await new Promise((r) => setTimeout(r, 5000));
    }
  })();
  let busy = false;
  let lastEval = 0;

  const enter = async (
    d: { side: Side; kind: "ls-fade" | "ls-strong"; move: number; typical: number },
    elapsed: number,
    st: { score: number; used: string } | null,
  ) => {
    if (await already()) return;
    const mv = `move ${d.move > 0 ? "+" : ""}${d.move.toFixed(2)} $ (typical ±${d.typical.toFixed(2)} $)`;
    const sc = st ? `strength ${st.score > 0 ? "+" : ""}${st.score.toFixed(0)} (${st.used})` : "no strength score";
    const why = d.kind === "ls-fade"
      ? `Lightspeed fade at ${Math.round(elapsed)} s: ${mv} beat the typical move but ${sc} is weak → ${d.side}`
      : `Lightspeed strong at ${Math.round(elapsed)} s: ${sc}, ${mv} → ${d.side}`;
    const bet = d.kind === "ls-fade" ? cfg.lsBet : cfg.strongBet;
    if (!market) return skip(start, `${why}, but no Polymarket 5-minute market found for this window (${lastSearch})`.slice(0, 700));
    if (chk?.ok === false) return skip(start, `${why}; market ${market.slug} (YES = ${market.longIs}) but ${chk.note}`.slice(0, 700));
    let price: number | null = await priceFor(market, d.side).catch(() => null);
    let shares = 0;
    let fees = 0;
    let orderId: string | null = null;
    if (cfg.mode === "live") {
      try {
        const f = await marketBuy(market, d.side, bet);
        orderId = f.id;
        shares = f.shares;
        fees = f.fees;
        if (shares > 0) price = f.price;
      } catch (e) {
        return skip(start, `${why}; market order failed: ${(e as Error).message}`.slice(0, 500));
      }
      if (!shares) return skip(start, `${why}; market order filled nothing`);
    } else if (price && price > 0) shares = bet / price;
    else return skip(start, `${why}; no price for ${d.side}`);
    // Fades sell at the take-profit; strength buys are held to settlement.
    const target = d.kind === "ls-fade" ? takeProfitPrice(price ?? 0, cfg.takeProfit) : null;
    await sql`insert into fadebot_bets5 (window_start, mode, status, market_slug, long_is, side, step, stake, price, shares, fees,
        limit_shares, limit_filled, open_ref, order_id, kind, reason, target_price)
      values (${start}, ${cfg.mode}, 'open', ${market.slug}, ${market.longIs}, ${d.side}, 0, ${bet}, ${price ?? 0},
        ${shares}, ${fees}, 0, 0, ${before?.avg ?? null}, ${orderId}, ${d.kind},
        ${`${why}${d.kind === "ls-fade" && target === null ? "; double the price is $1 or more, so held to settlement" : ""}${
          chk?.ok ? "" : `; YES = ${market.longIs} from the ${lastHow}`
        }`.slice(0, 700)}, ${target})
      on conflict (window_start) do nothing`;
  };

  const onTick = (t: number, p: number) => {
    if (!forming || t < start) return;
    forming.high = Math.max(forming.high, p);
    forming.low = Math.min(forming.low, p);
    forming.close = p;
    const elapsed = t - start;
    // (each mark is taken just before its second so the minute's run, which ends at second 59, still sees it)
    const mark = marks.length && elapsed >= marks[0] - 1.5 ? marks.shift() : undefined;
    if (!mark && (done || busy || Date.now() - lastEval < 200)) return;
    lastEval = Date.now();
    const ls = lightspeedCore(closed, start, TF, elapsed, forming);
    const st = candleStrength(ls, liveNow, elapsed, TF, forming);
    if (st && mark) {
      sql`insert into fadebot_strength (window_start, at_sec, score, used, move)
        values (${start}, ${mark}, ${st.score}, ${st.used}, ${forming.close - forming.open}) on conflict do nothing`.catch(() => {});
    }
    if (done || busy) return;
    if (st && elapsed >= cfg.strongFromSec && elapsed < cfg.strongToSec) bestStrength = Math.max(bestStrength, st.strength);
    const d = lightspeedDecision(ls, st, elapsed, rule);
    const fp = ls?.finish_probability as { move_dollars?: number; typical_move_in_time_left_dollars?: number } | undefined;
    if (fp?.typical_move_in_time_left_dollars) {
      const ratio = Math.abs(fp.move_dollars ?? 0) / fp.typical_move_in_time_left_dollars;
      if (ratio > best.ratio) best = { ratio, move: fp.move_dollars ?? 0, typical: fp.typical_move_in_time_left_dollars, at: elapsed };
    }
    if ("skip" in d) return;
    busy = true;
    done = true;
    enter(d, elapsed, st)
      .catch((e) => skip(start, `error: ${(e as Error).message}`.slice(0, 300)))
      .finally(() => (busy = false));
  };

  const [{ ticks, source }] = await Promise.all([record(until, onTick), watchExits(until), liveLoop]);
  await savePeriod(from, from + 60, ticks, source);
  while (busy) await new Promise((r) => setTimeout(r, 200));
  // The end of the watch: say why there was no bet (shown on the page).
  if (!done && (minute + 1) * 60 >= watchEnd) {
    const why = !before
      ? "no candle open (the minute before the window wasn't recorded)"
      : closed.length < 60
        ? "not enough candle history"
        : `${cfg.lsFade ? `the move never beat the typical move in the first ${cfg.lsWindowSec} s (closest: ${
          best.move > 0 ? "+" : ""
        }${best.move.toFixed(2)} $ vs ±${best.typical.toFixed(2)} $ at ${Math.round(best.at)} s) and ` : ""}the candle never got ${
          cfg.strongMin
        } strong between ${cfg.strongFromSec} and ${cfg.strongToSec} s (strongest ${bestStrength.toFixed(0)})`;
    await skip(start, `Lightspeed: ${why}: no bet`);
  }
  return `watched minute ${minute + 1} (${ticks.length} ticks from ${source})`;
}

// ── Jev trader (FADEBOT_STRATEGY = jev-trader, the default) ────────────

/** Both sides' buy and sell prices from one BBO read (prices on the book are the YES side's). */
async function quotes(m: WindowMarket) {
  const b = await bbo(m.slug);
  const bid = b.bestBid ? Number(b.bestBid.value) : null;
  const ask = b.bestAsk ? Number(b.bestAsk.value) : null;
  const inv = (x: number | null) => (x === null ? null : Number((1 - x).toFixed(4)));
  const yes = { cost: ask, sell: bid };
  const no = { cost: inv(bid), sell: inv(ask) };
  const up = m.longIs === "up" ? yes : no;
  const down = m.longIs === "up" ? no : yes;
  return { upCost: up.cost, downCost: down.cost, upSell: up.sell, downSell: down.sell };
}

/** Money available to buy with: Polymarket buying power (live), or the bankroll plus all test P&L (test mode). */
async function traderBalance(live: boolean, bankroll: number, strategy = "trader"): Promise<number> {
  if (live) {
    const r = await pm().account.balances();
    const b = r.balances?.find((x) => (x.currency ?? "USD").toUpperCase() === "USD") ?? r.balances?.[0];
    if (!b) throw new Error("no Polymarket balance");
    return Number(b.buyingPower ?? b.currentBalance ?? 0);
  }
  const r = await db()`select coalesce(sum(pnl), 0) as p from fadebot_trades where mode = 'dry' and status <> 'open'
    and coalesce(strategy, 'trader') = ${strategy}`;
  const open = await db()`select coalesce(sum(stake), 0) as s from fadebot_trades where mode = 'dry' and status = 'open'
    and coalesce(strategy, 'trader') = ${strategy}`;
  return bankroll + Number(r[0].p) - Number(open[0].s);
}

/** Realized trader P&L since midnight New York time. */
async function traderToday(): Promise<number> {
  const r = await db()`select coalesce(sum(pnl), 0) as p from fadebot_trades where status <> 'open'
    and coalesce(strategy, 'trader') = 'trader' and closed_at >=
    (date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York')`;
  return Number(r[0]?.p ?? 0);
}

/** Update a limit order's fills (live: the order's filled quantity and average price; test: filled once the side's
 *  price is at or under the limit). */
// deno-lint-ignore no-explicit-any
async function limitFill(t: any, q?: { upCost: number | null; downCost: number | null }) {
  const want = Number(t.limit_shares);
  const lp = Number(t.limit_price);
  let filled = Number(t.shares);
  let price = Number(t.price);
  if (t.mode === "live" && t.order_id) {
    const r = await pm().orders.retrieve(t.order_id);
    const cum = Number(r.order?.cumQuantity ?? 0);
    const avg = Number(r.order?.avgPx?.value ?? NaN);
    if (cum > filled) {
      filled = cum;
      if (Number.isFinite(avg) && avg > 0) {
        // Order prices are YES prices; for the NO side take whichever reading is closer to the limit.
        price = t.side !== t.long_is && Math.abs(1 - avg - lp) < Math.abs(avg - lp) ? 1 - avg : avg;
      }
    }
  } else if (q) {
    const now = t.side === "up" ? q.upCost : q.downCost;
    if (now !== null && now <= lp && filled < want) {
      filled = want;
      price = Math.min(lp, now);
    }
  }
  const changed = filled !== Number(t.shares);
  if (changed) await db()`update fadebot_trades set shares = ${filled}, price = ${price} where id = ${t.id}`;
  return { filled, price, changed };
}

/** Settle trader positions held to the end of their window. */
async function settleTrades() {
  const sql = db();
  const now = Math.floor(Date.now() / 1000);
  // Flip watches whose window ended without the other side reaching its price: nothing was bought.
  await sql`update fadebot_trades set status = 'settled', result = 'not triggered', pnl = 0, closed_at = now()
    where status = 'watching' and window_start + ${TF} <= ${now}`;
  const open = await sql`select * from fadebot_trades where status = 'open' and window_start + ${TF + 70} <= ${now}`;
  for (const t of open) {
    const end = Number(t.window_start) + TF;
    let won: Side | null = await settledSide({ slug: t.market_slug, longIs: t.long_is } as WindowMarket).catch(() => null);
    if (!won) {
      const fin = await period(end - 60);
      if (fin && fin.n >= 20 && t.open_ref !== null && (t.mode === "dry" || now > end + 900)) won = winner(t.open_ref, fin.avg);
      else if (now > end + 3600) {
        await sql`update fadebot_trades set status = 'void', result = 'could not settle', closed_at = now() where id = ${t.id}`;
        continue;
      }
    }
    if (!won) continue;
    let shares = Number(t.shares);
    if (t.order_type === "limit" && t.mode === "live") {
      shares = (await limitFill(t).catch(() => ({ filled: shares }))).filled;
      t.price = (await sql`select price from fadebot_trades where id = ${t.id}`)[0]?.price ?? t.price;
    }
    if (t.order_type === "limit" && !(shares > 0)) {
      await sql`update fadebot_trades set status = 'settled', result = 'unfilled', pnl = 0, closed_at = now()
        where id = ${t.id} and status = 'open'`;
      continue;
    }
    const ok = won === t.side;
    const p = shares * ((ok ? 1 : 0) - Number(t.price)) - Number(t.fees ?? 0);
    await sql`update fadebot_trades set status = 'settled', result = ${ok ? "win" : "loss"}, pnl = ${p}, closed_at = now()
      where id = ${t.id} and status = 'open'`;
  }
}

/** One minute of the Jev trader for window `start`: record BRTI and ask Jev again and again until `until`. */
async function traderRun(start: number, minute: number, until: number) {
  const sql = db();
  const cfg = settings();
  const tc: TraderCfg & {
    live: boolean;
    dailyLoss: number;
    gapSec: number;
    sell: boolean;
    invert: boolean;
    allIn: boolean;
    order: "market" | "limit" | "flip";
    flipAt: number;
    flipMax: number;
    flipBet: number;
    betPct: number;
    trend: boolean;
    limitPrice: number;
    limitShares: number;
    cheapBet: number;
  } = cfg.trader;
  const live = cfg.mode === "live" && tc.live;
  const mode = live ? "live" : "dry";
  const from = start + minute * 60;
  const end = start + TF;
  // Start recording at once (and save the minute as soon as it ends, not after the last Jev answer: the next run
  // reads this minute as its candle open).
  let forming: Candle | null = null;
  const early: { t: number; p: number }[] = [];
  const onTick = (t: number, p: number) => {
    if (t < start) return;
    if (!forming) {
      early.push({ t, p });
      return;
    }
    forming.high = Math.max(forming.high, p);
    forming.low = Math.min(forming.low, p);
    forming.close = p;
  };
  const recording = record(until, onTick).then(async (r) => {
    await savePeriod(from, from + 60, r.ticks, r.source);
    return r;
  });
  const [closed, market] = await Promise.all([
    closedCandles(start, 4).catch(() => [] as Candle[]),
    findMarket(start).catch(() => null),
  ]);
  // The candle open, as the website has it: the last BRTI price before the window (the previous run saves it right
  // at the end of its minute). Wait a little for it, then fall back to the last closed candle's close.
  let before = await period(start - 60);
  for (let k = 0; !before && k < 8 && Date.now() / 1000 < until - 5; k++) {
    await new Promise((r) => setTimeout(r, 1000));
    before = await period(start - 60);
  }
  const prevClose = closed.length && closed[closed.length - 1].time === start - TF ? closed[closed.length - 1].close : null;
  const openPx = before?.last ?? prevClose;
  if (openPx !== null) {
    const f: Candle = { time: start, open: openPx, high: openPx, low: openPx, close: openPx };
    for (let k = 0; k < minute; k++) {
      const pk = await period(start + k * 60);
      if (pk) {
        f.high = Math.max(f.high, pk.high);
        f.low = Math.min(f.low, pk.low);
        f.close = pk.last;
      }
    }
    for (const x of early) {
      f.high = Math.max(f.high, x.p);
      f.low = Math.min(f.low, x.p);
      f.close = x.p;
    }
    forming = f;
  }
  let liveNow: Record<string, unknown> | null = null;
  const liveLoop = (async () => {
    while (forming && Date.now() / 1000 < until) {
      liveNow = await lightspeedLive({ market: "btc", coinbase: "BTC-USD", tfSec: TF, forTime: start, open: openPx })
        .catch(() => liveNow);
      await new Promise((r) => setTimeout(r, 5000));
    }
  })();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let asks = 0;
  let limitLogged = false;
  const logAsk = (row: Record<string, unknown>) =>
    sql`insert into fadebot_asks ${sql({ window_start: start, ...row })}`.catch((e) => console.error("ask log:", e.message));

  const asker = (async () => {
    if (!forming || !market) {
      await logAsk({
        at_sec: Date.now() / 1000 - start,
        did: !forming
          ? "no candle open (no BRTI for the minute before the window, and no closed candle from the chart feed)"
          : `no Polymarket market (${lastSearch})`,
      });
      return;
    }
    await sleep(1500); // let the first ticks and the live block arrive
    while (Date.now() / 1000 < until - 1) {
      const t0 = Date.now();
      const elapsed = t0 / 1000 - start;
      const left = TF - elapsed;
      if (left < 3) break;
      let row: Record<string, unknown> = { at_sec: elapsed };
      try {
        const [q, posRows, nRows, today] = await Promise.all([
          quotes(market),
          sql`select * from fadebot_trades where window_start = ${start} and status in ('open', 'watching')
            and coalesce(strategy, 'trader') = 'trader' order by id desc limit 1`,
          sql`select count(*)::int as n from fadebot_trades where window_start = ${start}
            and coalesce(strategy, 'trader') = 'trader'`,
          traderToday(),
        ]);
        const pos = posRows[0] ?? null;
        if (pos && pos.status === "watching") {
          // Flip: Jev's pick triggered; buy the other side once it costs FADEBOT_TRADER_FLIP_AT or more.
          const other = pos.side as Side;
          const c = other === "up" ? q.upCost : q.downCost;
          const left = TF - (Date.now() / 1000 - start);
          const watchNote = `waiting for ${other} to reach ${Math.round(tc.flipAt * 100)}¢ (now ${
            c === null ? "—" : `${Math.round(c * 100)}¢`
          })`;
          if (c !== null && c >= tc.flipAt - 1e-9 && c <= tc.flipMax + 1e-9 && left >= tc.minLeftSec) {
            // Size: % of the balance (default 10%), or the fixed flip bet.
            let bet = tc.flipBet;
            let sizeNote = "";
            if (tc.betPct > 0) {
              const bal = await traderBalance(live, tc.bankroll);
              bet = Math.max(1, Math.floor(bal * (tc.betPct / 100) * 100) / 100);
              sizeNote = ` (${tc.betPct}% of $${bal.toFixed(2)})`;
            }
            const buySide: Side = other;
            const cost = c;
            let shares = bet / cost;
            let price = cost;
            let fees = 0;
            let orderId: string | null = null;
            if (live) {
              const f = await marketBuy(market, buySide, bet);
              if (!f.shares) throw new Error("market buy filled nothing");
              shares = f.shares;
              price = f.price;
              fees = f.fees;
              orderId = f.id;
            }
            await sql`update fadebot_trades set status = 'open', side = ${buySide}, stake = ${bet}, shares = ${shares},
                price = ${price}, fees = ${fees}, order_id = ${orderId}, opened_sec = ${Date.now() / 1000 - start},
                reason = ${`${pos.reason}; ${other} reached ${Math.round(c * 100)}¢ → bought ${buySide} $${bet.toFixed(2)}${sizeNote}`}
              where id = ${pos.id} and status = 'watching'`;
            await logAsk({ ...row, up_cost: q.upCost, down_cost: q.downCost, pos_side: buySide,
              did: `${other} reached ${Math.round(c * 100)}¢: bought ${buySide} $${bet.toFixed(2)}${sizeNote} @ ${price.toFixed(2)}` });
            continue;
          }
          if (!limitLogged) {
            limitLogged = true;
            await logAsk({ ...row, up_cost: q.upCost, down_cost: q.downCost, pos_side: other,
              did: c !== null && c > tc.flipMax ? `${watchNote}; over ${Math.round(tc.flipMax * 100)}¢, skipped` : watchNote });
          }
          await sleep(1000);
          continue;
        }
        if (pos && pos.order_type === "limit" && Number(pos.shares) < Number(pos.limit_shares) - 1e-9) {
          // A limit order is waiting: keep checking how much has filled (no more Jev questions this window).
          const f = await limitFill(pos, q);
          if (f.changed || !limitLogged) {
            limitLogged = true;
            await logAsk({
              ...row,
              up_cost: q.upCost,
              down_cost: q.downCost,
              pos_side: pos.side,
              did: `limit ${Number(pos.limit_shares)} ${pos.side} @ ${Math.round(Number(pos.limit_price) * 100)}¢: ${
                f.filled
              } filled`,
            });
          }
          await sleep(2000);
          continue;
        }
        if (pos && !tc.sell) {
          // Holding to settlement: nothing more to decide in this window (one position at a time).
          row = {
            ...row,
            up_cost: q.upCost,
            down_cost: q.downCost,
            up_sell: q.upSell,
            down_sell: q.downSell,
            pos_side: pos.side,
            did: `holding ${pos.side} to settlement`,
          };
          await logAsk(row);
          break;
        }
        const sellNow = pos ? (pos.side === "up" ? q.upSell : q.downSell) : null;
        const value = pos && sellNow !== null ? Number(pos.shares) * sellNow : null;
        const unreal = pos && value !== null ? value - Number(pos.shares) * Number(pos.price) - Number(pos.fees ?? 0) : null;
        const core = lightspeedCore(closed, start, TF, elapsed, forming);
        const strength = candleStrength(core, liveNow, elapsed, TF, forming);
        const r2 = (x: number) => Number(x.toFixed(2));
        // The trend (5m EMA 9/21 live, as on the chart; your TV indicator) and how our recent buys went.
        const tvLive = runTvIndicator(closed.slice(-3000), forming).live;
        const atr = (core?.volatility as { atr_dollars?: number } | undefined)?.atr_dollars ?? null;
        const trend = trendSummary(closed, forming.close, tvLive?.emaFast ?? null, tvLive?.emaSlow ?? null, atr);
        const recent = await sql`select window_start, side, price, p_side, status, result, pnl, opened_at from fadebot_trades
          where mode = ${mode} and coalesce(strategy, 'trader') = 'trader' order by id desc limit 10`;
        const recentTrades = recent.map((t) => ({
          minutes_ago: Math.round((Date.now() - new Date(t.opened_at).getTime()) / 60000),
          bought: t.side,
          cost_cents: Math.round(Number(t.price) * 100),
          your_chance_then_pct: t.p_side === null ? null : Math.round(Number(t.p_side) * 100),
          result: t.status === "open" ? "open" : t.result,
          pnl_dollars: t.pnl === null ? null : r2(Number(t.pnl)),
        }));
        const closedT = recentTrades.filter((t) => t.result === "win" || t.result === "loss");
        let streak = 0;
        for (const t of closedT) {
          if (t.result !== closedT[0].result || t.bought !== closedT[0].bought) break;
          streak += 1;
        }
        const state = {
          instrument: "Polymarket US BTC Up/Down 5-minute (settles on CF Benchmarks BRTI)",
          candle_so_far: {
            seconds_in: Math.round(elapsed),
            seconds_left: Math.round(left),
            open: r2(forming.open),
            high: r2(forming.high),
            low: r2(forming.low),
            price_now: r2(forming.close),
            move_dollars: r2(forming.close - forming.open),
            color_now: forming.close > forming.open ? "green" : forming.close < forming.open ? "red" : "flat",
          },
          last_40_candles: closed.slice(-40).map((c) => ({
            o: r2(c.open), h: r2(c.high), l: r2(c.low), c: r2(c.close),
            color: c.close > c.open ? "G" : c.close < c.open ? "R" : "-",
          })),
          trend,
          tv_indicator: tvContext(closed, start, TF, forming.close),
          your_recent_trades: {
            last_10: recentTrades,
            streak: closedT.length
              ? `${streak} ${closedT[0].result === "loss" ? "losses" : "wins"} in a row buying ${closedT[0].bought}`
              : "no finished trades yet",
          },
          lightspeed: core,
          candle_strength: strength,
          lightspeed_live: liveNow,
          polymarket: { up_cost: q.upCost, down_cost: q.downCost, up_sell: q.upSell, down_sell: q.downSell },
          position: pos
            ? {
              side: pos.side,
              shares: Number(Number(pos.shares).toFixed(3)),
              average_cost: Number(pos.price),
              cost_dollars: r2(Number(pos.shares) * Number(pos.price)),
              sells_for_now: sellNow,
              value_now_dollars: value === null ? null : r2(value),
              unrealized_pnl_dollars: unreal === null ? null : r2(unreal),
              unrealized_pnl_pct: unreal === null ? null : r2((unreal / (Number(pos.shares) * Number(pos.price))) * 100),
              held_seconds: Math.round(elapsed - Number(pos.opened_sec)),
              your_chance_when_bought_pct: pos.p_side === null ? null : Math.round(Number(pos.p_side) * 100),
            }
            : null,
          limits: {
            buys_this_window: nRows[0].n,
            max_buys_per_window: tc.maxEntries,
            realized_pnl_today_dollars: r2(today),
            daily_loss_limit_dollars: tc.dailyLoss,
            no_buys_when_cost_between: tc.banLo !== undefined && tc.banHi !== undefined
              ? `${Math.round(tc.banLo * 100)}¢ and ${Math.round(tc.banHi * 100)}¢ (the bot refuses those buys)`
              : null,
            sizing: tc.allIn
              ? `ALL-IN: every buy uses the whole balance (a loss empties the account); only with ${
                Math.round(tc.edge * 100)
              }+ points of edge`
              : `the bot sizes buys itself: ${tc.kelly} Kelly of $${tc.bankroll}, at most $${tc.maxBet}, only with ${
                Math.round(tc.edge * 100)
              }+ points of edge`,
          },
        };
        const via = lastQuoteVia;
        const jev = await askJevTrader(state, !!pos, Math.round(tc.edge * 100));
        asks += 1;
        row = {
          ...row,
          p_up: jev.pUp,
          action: jev.action,
          probs: sql.json(jev.actionProbs),
          up_cost: q.upCost,
          down_cost: q.downCost,
          up_sell: q.upSell,
          down_sell: q.downSell,
          pos_side: pos?.side ?? null,
          unrealized: unreal,
          ms: Date.now() - t0,
        };
        const nowEl = Date.now() / 1000 - start;
        // Limit mode: the edge is measured against what the order would pay (the limit, or less if already cheaper).
        const lim = tc.order === "limit"
          ? {
            upCost: q.upCost === null ? tc.limitPrice : Math.min(q.upCost, tc.limitPrice),
            downCost: q.downCost === null ? tc.limitPrice : Math.min(q.downCost, tc.limitPrice),
          }
          : q;
        const d = traderDecision(
          { action: jev.action, pUp: jev.pUp },
          lim,
          pos ? { side: pos.side } : null,
          { secondsLeft: TF - nowEl, entries: nRows[0].n, lossLimitHit: today <= -tc.dailyLoss },
          tc.order === "limit" ? { ...tc, minBet: 0 } : tc,
        );
        // Runs overlap for a moment at each minute: never buy if another run just opened a position.
        const raced = "buy" in d &&
          (await sql`select 1 from fadebot_trades where window_start = ${start} and status in ('open', 'watching')
            and coalesce(strategy, 'trader') = 'trader'`).length > 0;
        if (raced) row.did = "another run just bought: skipped";
        else if ("buy" in d) {
          // Jev's trade, or (fading Jev) the other side for the same dollars.
          const side: Side = tc.invert ? (d.buy === "up" ? "down" : "up") : d.buy;
          const cost = tc.invert ? (side === "up" ? q.upCost : q.downCost) : d.cost;
          if (cost === null || !(cost > 0 && cost < 1)) throw new Error(`no price for ${side}`);
          const pSide = tc.invert ? 1 - d.p : d.p;
          if (tc.allIn && tc.order === "market") {
            const bal = await traderBalance(live, tc.bankroll);
            const all = Math.floor(bal * 0.97 * 100) / 100;
            if (!(all >= 1)) throw new Error(`all-in: balance $${bal.toFixed(2)} is too small to buy`);
            d.stake = all;
          }
          if (tc.order === "flip") {
            let other: Side = side === "up" ? "down" : "up";
            let note = "";
            // Trend-aware: if the side the flip would buy is ALREADY at 60¢+ when Jev's call comes in, and it's against
            // the trend (Up already high in a downtrend, Down in an uptrend), don't buy it straight away — watch the
            // trend's side instead and buy that once it reaches 60¢. A later cross of 60¢ is unchanged.
            const otherNow = other === "up" ? q.upCost : q.downCost;
            if (tc.trend && otherNow !== null && otherNow >= tc.flipAt - 1e-9) {
              const tr = trend; // the same trend picture Jev was just given
              const want = trendFlipSide(other, tr.label);
              if (want !== other) {
                note = `; ${tr.label} and ${other} already ${Math.round(otherNow * 100)}¢ → waiting for ${want} instead`;
                other = want;
              }
            }
            await sql`insert into fadebot_trades (window_start, mode, market_slug, long_is, side, stake, shares, price, fees,
                opened_sec, p_side, open_ref, reason, order_type, status)
              values (${start}, ${mode}, ${market.slug}, ${market.longIs}, ${other}, 0, 0, 0, 0, ${nowEl}, ${1 - pSide},
                ${before?.avg ?? null},
                ${`Jev ${Math.round(d.p * 100)}% for ${d.buy} at ${Math.round(nowEl)} s → waiting for ${other} to reach ${
                  Math.round(tc.flipAt * 100)
                }¢${note}`}, 'flip', 'watching')`;
            row.did = `Jev picked ${d.buy}: waiting for ${other} to reach ${Math.round(tc.flipAt * 100)}¢${note}`;
            await logAsk(row);
            continue;
          }
          if (tc.order === "limit") {
            // 15 shares at 33¢ (or what's set), good until the window ends; filled shares are tracked as they come.
            const lp = tc.limitPrice;
            const n = tc.limitShares;
            const sideNow = side === "up" ? q.upCost : q.downCost;
            if (sideNow !== null && sideNow < lp - 1e-9) {
              // Already under the limit: buy $1 (FADEBOT_TRADER_CHEAP_BET) at market instead.
              let shares = tc.cheapBet / sideNow;
              let price = sideNow;
              let fees = 0;
              let orderId: string | null = null;
              if (live) {
                const f = await marketBuy(market, side, tc.cheapBet);
                if (!f.shares) throw new Error("market buy filled nothing");
                shares = f.shares;
                price = f.price;
                fees = f.fees;
                orderId = f.id;
              }
              await sql`insert into fadebot_trades (window_start, mode, market_slug, long_is, side, stake, shares, price, fees,
                  opened_sec, p_side, order_id, open_ref, reason, order_type)
                values (${start}, ${mode}, ${market.slug}, ${market.longIs}, ${side}, ${tc.cheapBet}, ${shares}, ${price},
                  ${fees}, ${nowEl}, ${pSide}, ${orderId}, ${before?.avg ?? null},
                  ${`Jev ${Math.round(d.p * 100)}% for ${d.buy}, ${side} already ${Math.round(sideNow * 100)}¢ (under ${
                    Math.round(lp * 100)
                  }¢) → $${tc.cheapBet} market buy at ${Math.round(nowEl)} s`}, 'market')`;
              row.did = `${side} under ${Math.round(lp * 100)}¢: bought $${tc.cheapBet} @ ${price.toFixed(2)}`;
              await logAsk(row);
              continue;
            }
            const orderId = live ? await limitBuy(market, side, lp, n, end) : null;
            const instant = !live && sideNow !== null && sideNow <= lp; // test mode: fills at once at exactly the limit
            await sql`insert into fadebot_trades (window_start, mode, market_slug, long_is, side, stake, shares, price, fees,
                opened_sec, p_side, order_id, open_ref, reason, order_type, limit_price, limit_shares)
              values (${start}, ${mode}, ${market.slug}, ${market.longIs}, ${side}, ${lp * n}, ${instant ? n : 0},
                ${instant ? sideNow : lp}, 0, ${nowEl}, ${pSide}, ${orderId}, ${before?.avg ?? null},
                ${`Jev ${Math.round(d.p * 100)}% for ${d.buy}, ${side} costs ${
                  sideNow === null ? "—" : `${Math.round(sideNow * 100)}¢`
                } → limit ${n} @ ${Math.round(lp * 100)}¢ at ${Math.round(nowEl)} s`}, 'limit', ${lp}, ${n})`;
            row.did = `limit ${n} ${side} @ ${Math.round(lp * 100)}¢${instant ? " (filled)" : ""}`;
            await logAsk(row);
            continue;
          }
          let shares = d.stake / cost;
          let price = cost;
          let fees = 0;
          let orderId: string | null = null;
          if (live) {
            const f = await marketBuy(market, side, d.stake);
            if (!f.shares) throw new Error("market buy filled nothing");
            shares = f.shares;
            price = f.price;
            fees = f.fees;
            orderId = f.id;
          }
          await sql`insert into fadebot_trades (window_start, mode, market_slug, long_is, side, stake, shares, price, fees,
              opened_sec, p_side, order_id, open_ref, reason)
            values (${start}, ${mode}, ${market.slug}, ${market.longIs}, ${side}, ${d.stake}, ${shares}, ${price}, ${fees},
              ${nowEl}, ${pSide}, ${orderId}, ${before?.avg ?? null},
              ${`${tc.invert ? `faded Jev: it wanted ${d.buy}` : `Jev`} (${Math.round(d.p * 100)}% for ${d.buy} vs ${
                Math.round(d.cost * 100)
              }¢) at ${Math.round(nowEl)} s`})`;
          row.did = `${tc.invert ? `faded Jev's ${d.buy}: ` : ""}bought ${side} $${d.stake.toFixed(2)} @ ${price.toFixed(2)}`;
        } else if ("sell" in d && pos) {
          let exit = sellNow;
          let fees = Number(pos.fees ?? 0);
          let exitId: string | null = null;
          let sold = Number(pos.shares);
          if (live) {
            const f = await marketSellAll(market, pos.side, sellNow ?? 0);
            if (!f.shares) throw new Error("market sell filled nothing");
            exit = f.price;
            fees += f.fees;
            exitId = f.id;
            sold = Math.min(sold, f.shares);
          }
          if (exit === null) throw new Error("no sell price");
          const p = sold * (exit - Number(pos.price)) - fees;
          await sql`update fadebot_trades set status = 'sold', result = ${p > 0 ? "win" : "loss"}, exit_price = ${exit},
              exit_sec = ${nowEl}, exit_order_id = ${exitId}, pnl = ${p}, closed_at = now() where id = ${pos.id}`;
          row.did = `sold ${pos.side} @ ${exit.toFixed(2)} (${p >= 0 ? "+" : "−"}$${Math.abs(p).toFixed(2)})`;
        } else row.did = (d as { none: string }).none;
        if (row.did === "Jev: wait" && jev.pUp !== null) {
          // Say how far Jev's own chance is from each price, so a "wait" can be checked at a glance.
          const eu = q.upCost === null ? null : Math.round((jev.pUp - q.upCost) * 100);
          const ed = q.downCost === null ? null : Math.round((1 - jev.pUp - q.downCost) * 100);
          const f = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : ""}${x}`);
          row.did = `Jev: wait (edge Up ${f(eu)}, Down ${f(ed)} points)`;
        }
        if (via && via !== "bbo") row.did = `${row.did} [prices from the ${via}]`;
      } catch (e) {
        row.did = `error: ${(e as Error).message}`.slice(0, 300);
        await sleep(3000);
      }
      await logAsk(row);
      const gap = tc.gapSec * 1000 - (Date.now() - t0);
      if (gap > 0) await sleep(gap);
    }
  })();

  const [{ ticks, source }] = await Promise.all([recording, asker, liveLoop]);
  return `trader minute ${minute + 1}: ${asks} Jev asks, ${ticks.length} ticks from ${source}`;
}

/** Does Jev beat Polymarket's price? Every ask's favoured side, bucketed by Jev's chance minus that side's cost. */
async function traderStats(now: number) {
  const rows = await db()`select a.window_start, a.p_up, a.up_cost, a.down_cost, (c.last >= o.last) as green
    from fadebot_asks a
    join fadebot_prices o on o.period_start = a.window_start - 60
    join fadebot_prices c on c.period_start = a.window_start + 240
    where a.window_start > ${now - 7 * 86400} and a.window_start + ${TF} <= ${now} and a.p_up is not null
    order by a.id`;
  const buckets = [-100, 0, 5, 10, 20];
  const seen = new Set<string>();
  const acc = buckets.map((from) => ({ from, n: 0, wins: 0, cost: 0, ret: 0 }));
  for (const r of rows) {
    const up = r.p_up >= 0.5;
    const p = up ? r.p_up : 1 - r.p_up;
    const cost = up ? r.up_cost : r.down_cost;
    if (cost === null || !(cost > 0)) continue;
    const edge = (p - cost) * 100;
    const i = buckets.findLastIndex((b) => edge >= b);
    const key = `${r.window_start}:${i}`;
    if (seen.has(key)) continue; // one ask per window per bucket (asks in one window are nearly the same bet)
    seen.add(key);
    const win = up === r.green;
    const a = acc[i];
    a.n += 1;
    a.wins += win ? 1 : 0;
    a.cost += cost;
    a.ret += (win ? 1 : 0) / cost - 1;
  }
  return acc.map((a) => ({
    from: a.from,
    n: a.n,
    winPct: a.n ? Number(((a.wins / a.n) * 100).toFixed(1)) : null,
    avgCost: a.n ? Number((a.cost / a.n).toFixed(3)) : null,
    returnPerDollar: a.n ? Number((a.ret / a.n).toFixed(3)) : null,
  }));
}

// ── Longshot (FADEBOT_STRATEGY = longshot) ─────────────────────────────

/** The YES order book as [price, size] levels. */
async function yesBook(slug: string): Promise<{ bids: [number, number][]; offers: [number, number][] }> {
  // deno-lint-ignore no-explicit-any
  const r = (await pm().markets.book(slug)) as any;
  const d = r?.marketData ?? r ?? {};
  // deno-lint-ignore no-explicit-any
  const lv = (xs: any[] | undefined): [number, number][] =>
    (xs ?? [])
      .map((l) => [Number(l?.px?.value ?? l?.px ?? l?.price), Number(l?.qty ?? l?.quantity ?? l?.size ?? 0)] as [number, number])
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && q > 0);
  return { bids: lv(d.bids), offers: lv(d.offers ?? d.asks) };
}

async function kvSet(k: string, v: unknown) {
  await db()`insert into fadebot_kv (k, v, at) values (${k}, ${db().json(v as never)}, now())
    on conflict (k) do update set v = excluded.v, at = now()`.catch(() => {});
}

/** Current run of longshot wins (most recent first) and the best run. */
async function longshotStreak(mode: string) {
  const rows = await db()`select result from fadebot_trades where strategy = 'longshot' and mode = ${mode}
    and status in ('settled', 'sold') order by window_start desc, id desc limit 500`;
  let cur = 0;
  for (const r of rows) {
    if (r.result !== "win") break;
    cur += 1;
  }
  let best = 0;
  let run = 0;
  for (const r of [...rows].reverse()) {
    run = r.result === "win" ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { current: cur, best, total: rows.length };
}

/** One minute of longshot for window `start`: always record BRTI; in the last minutes, look for a near-certain side. */
async function longshotRun(start: number, minute: number, until: number) {
  const sql = db();
  const cfg = settings();
  const lc = cfg.longshot;
  const live = cfg.mode === "live" && lc.live;
  const mode = live ? "live" : "dry";
  const end = start + TF;
  const from = start + minute * 60;
  // Per-second last price (the closing average is taken over seconds), plus every tick for volatility.
  const perSec = new Map<number, number>();
  let last: number | null = null;
  const onTick = (t: number, p: number) => {
    perSec.set(Math.floor(t), p);
    last = p;
  };
  const recording = record(until, onTick).then(async (r) => {
    await savePeriod(from, from + 60, r.ticks, r.source);
    return r;
  });
  const lsCfg: LongshotCfg = lc;
  let note = "";
  const watcher = (async () => {
    const watchFrom = end - lc.windowSec;
    if (until < watchFrom) {
      note = `minute ${minute + 1}: recording (longshot looks in the last ${lc.windowSec} s)`;
      return;
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ref = await period(start - 60);
    if (!ref || ref.n < 20) {
      note = "no start price (the minute before the window wasn't recorded)";
      return;
    }
    const startRef = ref.avg;
    const [closed, market] = await Promise.all([
      closedCandles(start, 2).catch(() => [] as Candle[]),
      findMarket(start).catch(() => null),
    ]);
    if (!market) {
      note = `no Polymarket market (${lastSearch})`;
      return;
    }
    const core = lightspeedCore(closed, start, TF, 0, null);
    const perCandlePct = (core?.volatility as { per_candle_pct?: number } | undefined)?.per_candle_pct ?? null;
    let done = (await sql`select 1 from fadebot_trades where window_start = ${start} and strategy = 'longshot'`).length > 0;
    let logged = (await sql`select 1 from fadebot_longshot where window_start = ${start}`).length > 0;
    let bestP = 0;
    while (Date.now() / 1000 < until - 0.5) {
      const now = Date.now() / 1000;
      if (now < watchFrom || last === null) {
        await sleep(500);
        continue;
      }
      const price: number = last;
      // Known part of the closing average: per-second prices from end − 60 up to now.
      const closing = [...perSec.entries()].filter(([t]) => t >= end - 60 && t < end).map(([, p]) => p);
      const knownSec = Math.max(0, Math.min(60, now - (end - 60)));
      // If this run started after the closing minute began, the seconds it missed count as unknown: scale down.
      const coveredSec = Math.min(knownSec, closing.length);
      const knownAvg = closing.length ? closing.reduce((a, b) => a + b, 0) / closing.length : null;
      // Volatility: the larger of the candle-based figure and what BRTI is doing in this run (per second).
      const secs = [...perSec.entries()].sort((a, b) => a[0] - b[0]);
      let ss = 0;
      let nn = 0;
      for (let i = 1; i < secs.length; i++) {
        const dt = secs[i][0] - secs[i - 1][0];
        if (dt > 0 && dt <= 5) {
          ss += (secs[i][1] - secs[i - 1][1]) ** 2 / dt;
          nn += 1;
        }
      }
      const realized = nn >= 10 ? Math.sqrt(ss / nn) : 0;
      const fromCandles = perCandlePct === null ? 0 : (price * perCandlePct) / 100 / Math.sqrt(TF);
      const sigmaPerSec = Math.max(realized, fromCandles);
      if (!(sigmaPerSec > 0)) {
        note = "no volatility estimate yet";
        await sleep(1000);
        continue;
      }
      const est = settleProbability({
        startRef,
        now,
        end,
        price,
        knownAvg,
        knownSec: coveredSec,
        sigmaPerSec,
        safety: lc.safety,
        feedSd: lc.feedSd,
      });
      const pSide = Math.max(est.pUp, 1 - est.pUp);
      bestP = Math.max(bestP, pSide);
      const secondsLeft = end - now;
      note = `${Math.round(now - start)} s: expected close ${est.expectedFinal.toFixed(2)} vs start ${
        startRef.toFixed(2)
      } (±${est.sd.toFixed(2)}) → ${est.pUp >= 0.5 ? "up" : "down"} ${(pSide * 100).toFixed(3)}%`;
      if (done || pSide < lc.minProb || secondsLeft > lc.windowSec) {
        await sleep(1000);
        continue;
      }
      try {
        const q = await quotes(market);
        const d = longshotDecision({ pUp: est.pUp }, q, secondsLeft, lsCfg);
        if ("none" in d) {
          note += ` — ${d.none}`;
          await sleep(1000);
          continue;
        }
        // Size: all-in (balance less a 3% buffer) or a fixed bet, capped by what the book fills near this price.
        const book = await yesBook(market.slug).catch(() => null);
        const maxCost = Math.min(lc.maxCost, d.cost + lc.slipCents / 100);
        const depth = book ? depthDollars(book, d.side, market.longIs === "up", maxCost) : 0;
        const bal = await traderBalance(live, lc.bankroll, "longshot");
        const want = lc.allIn ? Math.floor(bal * 0.97 * 100) / 100 : lc.bet;
        const stake = Math.floor(Math.min(want, depth > 0 ? depth : want) * 100) / 100;
        const sig = { at_sec: now - start, side: d.side, p: d.p, cost: d.cost, start_ref: startRef };
        if (!(stake >= 1)) {
          if (!logged) {
            await sql`insert into fadebot_longshot ${sql({ window_start: start, ...sig, bought: false,
              note: `stake $${stake.toFixed(2)} too small (balance $${bal.toFixed(2)}, book $${depth.toFixed(2)})` })}
              on conflict do nothing`;
            logged = true;
          }
          note += ` — stake too small`;
          await sleep(1000);
          continue;
        }
        let shares = stake / d.cost;
        let price2 = d.cost;
        let fees = 0;
        let orderId: string | null = null;
        if (live) {
          const f = await marketBuy(market, d.side, stake);
          if (!f.shares) throw new Error("market buy filled nothing");
          shares = f.shares;
          price2 = f.price;
          fees = f.fees;
          orderId = f.id;
        }
        await sql`insert into fadebot_trades (window_start, mode, strategy, market_slug, long_is, side, stake, shares, price,
            fees, opened_sec, p_side, order_id, open_ref, reason)
          values (${start}, ${mode}, 'longshot', ${market.slug}, ${market.longIs}, ${d.side}, ${stake}, ${shares}, ${price2},
            ${fees}, ${now - start}, ${d.p}, ${orderId}, ${startRef},
            ${`${(d.p * 100).toFixed(3)}% ${d.side} at ${Math.round(now - start)} s, ${Math.round(d.cost * 100)}¢${
              lc.allIn ? `, all-in of $${bal.toFixed(2)}` : ""
            }${depth > 0 && depth < want ? ` (capped by the book: $${depth.toFixed(2)} at ≤${Math.round(maxCost * 100)}¢)` : ""}`})`;
        await sql`insert into fadebot_longshot ${sql({ window_start: start, ...sig, bought: true, note: null })}
          on conflict (window_start) do update set bought = true`;
        done = true;
        logged = true;
        note += ` — bought ${d.side} $${stake.toFixed(2)} @ ${price2.toFixed(3)}`;
      } catch (e) {
        note += ` — error: ${(e as Error).message}`.slice(0, 300);
        await sleep(2000);
      }
      await kvSet("longshot_last", { note, at: Date.now() / 1000, window: start });
      await sleep(1000);
    }
    if (!done && minute === 4) note = `${note} — best ${(bestP * 100).toFixed(3)}%, no buy this window`;
  })();
  // Publish the latest check every few seconds for the panel.
  const pub = (async () => {
    while (Date.now() / 1000 < until) {
      if (note) await kvSet("longshot_last", { note, at: Date.now() / 1000, window: start });
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  const [{ ticks, source }] = await Promise.all([recording, watcher, pub]);
  if (note) await kvSet("longshot_last", { note, at: Date.now() / 1000, window: start });
  return `longshot minute ${minute + 1}: ${ticks.length} ticks from ${source}; ${note}`;
}

/** How often the longshot rule's "near-certain" calls actually finished that way (our BRTI averages). */
async function longshotCalibration(now: number) {
  const rows = await db()`select l.window_start, l.side, l.p, l.cost, l.bought, l.start_ref, c.avg as close_avg
    from fadebot_longshot l join fadebot_prices c on c.period_start = l.window_start + 240
    where l.window_start + ${TF} <= ${now} and c.n >= 20`;
  let wins = 0;
  const misses: unknown[] = [];
  for (const r of rows) {
    const up = r.close_avg >= r.start_ref;
    const ok = (r.side === "up") === up;
    if (ok) wins += 1;
    else misses.push({ window_start: r.window_start, side: r.side, p: r.p, cost: r.cost });
  }
  return { n: rows.length, wins, misses: misses.slice(-10) };
}

async function run() {
  await setup();
  const now = Date.now() / 1000;
  const start = Math.floor(now / TF) * TF;
  const m = Math.floor((now - start) / 60);
  const done: string[] = [];
  await dryLimitCheck().catch(() => {});
  if (settings().strategy === "longshot") {
    done.push(await longshotRun(start, m, start + m * 60 + 58));
    await settleTrades();
    await db()`delete from fadebot_prices where period_start < ${Math.floor(now - 7 * 86400)}`;
    if (m === 2) await updatePmHistory(Date.now() / 1000).catch((e) => console.error("price history:", (e as Error).message));
    return done;
  }
  if (settings().strategy === "jev-trader") {
    done.push(await traderRun(start, m, start + m * 60 + 58));
    await settleTrades();
    await settle();
    await db()`delete from fadebot_prices where period_start < ${Math.floor(now - 3 * 86400)}`;
    await db()`delete from fadebot_asks where window_start < ${Math.floor(now - 7 * 86400)}`;
    if (m === 3) await updatePmHistory(Date.now() / 1000).catch((e) => console.error("price history:", (e as Error).message));
    return done;
  }
  if (settings().strategy === "lightspeed") {
    const watchMins = Math.ceil(Math.max(settings().lsWindowSec, settings().strongToSec) / 60);
    if (m === 4) {
      // The price to beat (and next window's candle open), while watching this window's take-profit.
      const from = start + 240;
      const [{ ticks, source }] = await Promise.all([record(from + 58), watchExits(from + 58)]);
      await savePeriod(from, from + 60, ticks, source);
      done.push(`recorded the price to beat (${ticks.length} ticks from ${source})`);
    } else if (m < watchMins) {
      done.push(await lightspeedWatch(start, m, start + m * 60 + 59));
    } else {
      await watchExits(start + m * 60 + 58);
      done.push("watched take-profit");
    }
    await settle();
    await db()`delete from fadebot_prices where period_start < ${Math.floor(now - 3 * 86400)}`;
    if (m === 3) await updatePmHistory(Date.now() / 1000).catch((e) => console.error("price history:", (e as Error).message));
    return done;
  }
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

/** How often candles finished the way their strength score pointed, by checkpoint and strength (last 7 days). */
async function strengthStats(now: number) {
  const rows = await db()`select s.window_start, s.at_sec, s.score, (c.last >= o.last) as green from fadebot_strength s
    join fadebot_prices o on o.period_start = s.window_start - 60
    join fadebot_prices c on c.period_start = s.window_start + 240
    where s.window_start > ${now - 7 * 86400} and s.window_start + ${TF} <= ${now}`;
  const buckets = [0, 20, 40, 60, 80];
  const out: { at: number; from: number; n: number; theirWay: number }[] = [];
  for (const at of [60, 120, 180, 240]) {
    for (const from of buckets) {
      const xs = rows.filter((r) => r.at_sec === at && Math.abs(r.score) >= from && Math.abs(r.score) < from + 20 && r.score !== 0);
      out.push({ at, from, n: xs.length, theirWay: xs.filter((r) => (r.score > 0) === r.green).length });
    }
  }
  return { windows: new Set(rows.map((r) => r.window_start)).size, rows: out };
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
    strength: await strengthStats(now).catch(() => null),
    longshot: cfg.strategy === "longshot"
      ? {
        live: cfg.mode === "live" && cfg.longshot.live,
        streak: await longshotStreak(cfg.mode === "live" && cfg.longshot.live ? "live" : "dry").catch(() => null),
        balance: await traderBalance(cfg.mode === "live" && cfg.longshot.live, cfg.longshot.bankroll, "longshot").catch(
          () => null,
        ),
        last: (await sql`select v, at from fadebot_kv where k = 'longshot_last'`.catch(() => []))[0] ?? null,
        trades: await sql`select * from fadebot_trades where strategy = 'longshot' order by id desc limit 40`.catch(() => []),
        calibration: await longshotCalibration(now).catch(() => null),
      }
      : null,
    trader: cfg.strategy === "jev-trader"
      ? {
        live: cfg.mode === "live" && cfg.trader.live,
        today: await traderToday().catch(() => 0),
        trades: await sql`select * from fadebot_trades where coalesce(strategy, 'trader') = 'trader'
            order by id desc limit 40`.catch(() => []),
        totals: (await sql`select count(*)::int as n, coalesce(sum(pnl), 0) as pnl,
            count(*) filter (where pnl > 0)::int as wins from fadebot_trades where status in ('sold', 'settled')
            and coalesce(strategy, 'trader') = 'trader'`.catch(
          () => [],
        ))[0] ?? null,
        asks: await sql`select window_start, at_sec, p_up, action, up_cost, down_cost, up_sell, down_sell, pos_side,
            unrealized, did, ms, created_at from fadebot_asks order by id desc limit 30`.catch(() => []),
        edge: await traderStats(now).catch(() => null),
      }
      : null,
    // Polymarket's prices per window (last 6 hours), with how the window ended (BRTI, Polymarket's rule).
    pmHistory: await db()`select h.window_start, h.up_low, h.down_low, h.up_read, h.down_read, h.n_points, h.long_is,
        h.error, h.sample, r.outcome from fadebot_pmhist h left join fadebot_reads5 r on r.window_start = h.window_start
        where h.window_start > ${now - 6 * 3600} order by h.window_start desc`.catch(() => []),
    // Price points per window (last 24 hours) for the backtest's fill check.
    pmPoints: await db()`select window_start, pts from fadebot_pmhist where window_start > ${now - 86400}
        and pts is not null and n_points > 0`.catch(() => []),
  };
}

// ── Report (read-only): real results from Polymarket's own account history ─

/**
 * Every BTC 5-minute trade and settlement on the account since `since` (unix seconds), straight from Polymarket's
 * activity history (with the bot's key; nothing is traded), grouped per window: what was bought, what it cost, how it
 * ended. Only BTC Up/Down 5-minute markets are included (no deposits or balances).
 */
async function report(since: number) {
  // deno-lint-ignore no-explicit-any
  const acts: any[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let reachedStart = false;
  while (pages < 60 && !reachedStart) {
    // deno-lint-ignore no-explicit-any
    const r: any = await pm().portfolio.activities({
      limit: 100,
      cursor,
      types: ["ACTIVITY_TYPE_TRADE", "ACTIVITY_TYPE_POSITION_RESOLUTION"],
      sortOrder: "SORT_ORDER_DESCENDING",
    });
    pages += 1;
    for (const a of r.activities ?? []) {
      const t = Date.parse(a.trade?.createTime ?? a.trade?.updateTime ?? a.positionResolution?.updateTime ?? "") / 1000;
      if (Number.isFinite(t) && t < since) {
        reachedStart = true;
        continue;
      }
      acts.push({ ...a, _t: t });
    }
    if (r.eof || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  const isBtc5 = (slug: string | undefined) => !!slug && /btc-updown-5m/.test(slug);
  const num = (v: unknown) => {
    const x = v && typeof v === "object" ? (v as { value?: unknown }).value : v;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  // Window start from the slug (…-YYYY-MM-DD-HHMMz).
  const windowOf = (slug: string) => {
    const m = /(\d{4})-(\d\d)-(\d\d)-(\d\d)(\d\d)z/.exec(slug);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 : null;
  };
  type W = {
    slug: string;
    window: number | null;
    buys: number;
    sells: number;
    qty: number;
    cost: number;
    prices: number[];
    resolved: boolean;
    net_before: number | null;
    realized: number | null;
    side_from_api: string | null;
  };
  const by = new Map<string, W>();
  const get = (slug: string): W => {
    let w = by.get(slug);
    if (!w) {
      w = { slug, window: windowOf(slug), buys: 0, sells: 0, qty: 0, cost: 0, prices: [], resolved: false,
        net_before: null, realized: null, side_from_api: null };
      by.set(slug, w);
    }
    return w;
  };
  for (const a of acts) {
    if (a.type === "ACTIVITY_TYPE_TRADE" && isBtc5(a.trade?.marketSlug)) {
      const w = get(a.trade.marketSlug);
      const q = num(a.trade.qty) ?? 0;
      const px = num(a.trade.price);
      const basis = num(a.trade.costBasis);
      const pnl = num(a.trade.realizedPnl);
      if (pnl !== null && pnl !== 0 && q < 0) w.sells += 1;
      else w.buys += 1;
      w.qty += Math.abs(q);
      w.cost += basis !== null ? Math.abs(basis) : px !== null ? Math.abs(q) * px : 0;
      if (px !== null) w.prices.push(px);
    }
    if (a.type === "ACTIVITY_TYPE_POSITION_RESOLUTION" && isBtc5(a.positionResolution?.marketSlug)) {
      const pr = a.positionResolution;
      const w = get(pr.marketSlug);
      w.resolved = true;
      w.net_before = num(pr.beforePosition?.netPosition);
      const rb = num(pr.beforePosition?.realized) ?? 0;
      const ra = num(pr.afterPosition?.realized);
      w.realized = ra === null ? null : ra - rb;
      w.side_from_api = pr.side ?? null;
    }
  }
  // The bot's own record of which side each window bought (Polymarket's history doesn't always say Up/Down).
  const slugs = [...by.keys()];
  const mine = slugs.length
    ? await db()`select market_slug, side, mode, count(*)::int as n from fadebot_trades
        where market_slug = any(${slugs}) group by market_slug, side, mode`.catch(() => [])
    : [];
  const sideOf = new Map(mine.map((r) => [r.market_slug, r.side]));
  const windows = [...by.values()]
    .sort((a, b) => (b.window ?? 0) - (a.window ?? 0))
    .map((w) => {
      const pnl = w.realized !== null ? w.realized : null;
      // Once settled, the cost follows from the P&L exactly (a win pays $1 a share): this doesn't depend on whether
      // Polymarket reports trade prices as YES or NO prices.
      if (w.resolved && pnl !== null && w.qty > 0) w.cost = pnl > 0 ? w.qty - pnl : -pnl;
      return {
        window: w.window ? new Date(w.window * 1000).toISOString() : w.slug,
        side: sideOf.get(w.slug) ?? (w.net_before === null ? null : w.net_before > 0 ? "long (YES)" : "short (NO)"),
        buys: w.buys,
        shares: Number(w.qty.toFixed(3)),
        cost: Number(w.cost.toFixed(2)),
        avg_price: w.qty ? Number((w.cost / w.qty).toFixed(3)) : null,
        pnl: pnl === null ? null : Number(pnl.toFixed(2)),
        result: !w.resolved ? "open / not settled" : pnl === null ? "settled (P&L unknown)" : pnl > 0 ? "win" : pnl < 0 ? "loss" : "even",
      };
    });
  const done = windows.filter((w) => w.result === "win" || w.result === "loss" || w.result === "even");
  const wins = done.filter((w) => w.result === "win").length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const bucket = (lo: number, hi: number) => {
    const xs = done.filter((w) => w.avg_price !== null && w.avg_price >= lo && w.avg_price < hi);
    const ww = xs.filter((w) => w.result === "win").length;
    return {
      prices: hi > 1 ? `${Math.round(lo * 100)}¢+` : `${Math.round(lo * 100)}–${Math.round(hi * 100)}¢`,
      trades: xs.length,
      win_pct: xs.length ? Number(((ww / xs.length) * 100).toFixed(1)) : null,
      pnl: Number(sum(xs.map((w) => w.pnl ?? 0)).toFixed(2)),
    };
  };
  const bySide = (side: string) => {
    const xs = done.filter((w) => w.side === side);
    return {
      trades: xs.length,
      win_pct: xs.length ? Number(((xs.filter((w) => w.result === "win").length / xs.length) * 100).toFixed(1)) : null,
      pnl: Number(sum(xs.map((w) => w.pnl ?? 0)).toFixed(2)),
    };
  };
  return {
    since: new Date(since * 1000).toISOString(),
    pages_read: pages,
    reached_since: reachedStart,
    summary: {
      settled_trades: done.length,
      wins,
      losses: done.filter((w) => w.result === "loss").length,
      win_pct: done.length ? Number(((wins / done.length) * 100).toFixed(1)) : null,
      total_pnl: Number(sum(done.map((w) => w.pnl ?? 0)).toFixed(2)),
      total_cost: Number(sum(done.map((w) => w.cost)).toFixed(2)),
      avg_price: done.length ? Number((sum(done.map((w) => w.cost)) / sum(done.map((w) => w.shares))).toFixed(3)) : null,
      windows_with_more_than_one_buy: windows.filter((w) => w.buys > 1).length,
      still_open: windows.length - done.length,
    },
    by_side: { up: bySide("up"), down: bySide("down") },
    by_price: [bucket(0, 0.6), bucket(0.6, 0.65), bucket(0.65, 0.7), bucket(0.7, 0.75), bucket(0.75, 1.01)],
    windows,
    // A few raw entries so the numbers above can be checked against Polymarket's own fields.
    raw_sample: {
      trade: acts.find((a) => a.type === "ACTIVITY_TYPE_TRADE") ?? null,
      resolution: acts.find((a) => a.type === "ACTIVITY_TYPE_POSITION_RESOLUTION") ?? null,
    },
  };
}

/** Monday 00:00 New York time of the current week, as unix seconds. */
function mondayNY(): number {
  const now = new Date();
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const offset = now.getTime() - ny.getTime();
  const d = new Date(ny);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return Math.floor((d.getTime() + offset) / 1000);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "status") return json(await status());
    if (body?.action === "report") {
      // Read-only: real results since Monday (or body.since, unix seconds / ISO date) from Polymarket's history.
      const since = body.since ? (Number(body.since) || Date.parse(String(body.since)) / 1000) : mondayNY();
      return json(await report(Math.floor(since)));
    }
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
      // What each Polymarket price endpoint says about this market (raw, trimmed).
      const probe = async (f: () => Promise<unknown>) => {
        try {
          return JSON.stringify(await f()).slice(0, 700);
        } catch (e) {
          return `error: ${(e as Error).message}`.slice(0, 300);
        }
      };
      const prices = m
        ? {
          bbo: await probe(() => pm().markets.bbo(m.slug)),
          book: await probe(() => pm().markets.book(m.slug)),
          market: await probe(() => pm().markets.retrieveBySlug(m.slug)),
          used: await probe(async () => ({ ...(await bbo(m.slug)), via: lastQuoteVia })),
        }
        : null;
      return json({
        check,
        prices,
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
    if (body?.action === "test-ls" && env("FADEBOT_ALLOW_TEST") === "1") {
      // Give the current window this candle open, then watch it for a few seconds.
      await setup();
      const now = Date.now() / 1000;
      const start = Math.floor(now / TF) * TF; // the real window (call it in its first 2 minutes)
      await db()`delete from fadebot_bets5 where window_start = ${start}`;
      const open = Number(body.open);
      await savePeriod(start - 60, start, Array.from({ length: 30 }, (_, i) => ({ t: start - 30 + i, p: open })), "test");
      const msg = await lightspeedWatch(start, Number(body.minute ?? 0), now + Number(body.watch ?? 6));
      return json({ msg, start, bet: (await db()`select * from fadebot_bets5 where window_start = ${start}`)[0] ?? null });
    }
    if (body?.action === "test-longshot" && env("FADEBOT_ALLOW_TEST") === "1") {
      // Give the current window this start price, widen the watch window, then run longshot for a few seconds.
      await setup();
      const now = Date.now() / 1000;
      const start = Math.floor(now / TF) * TF;
      if (body.reset) {
        await db()`delete from fadebot_trades where window_start = ${start} and strategy = 'longshot'`;
        await db()`delete from fadebot_longshot where window_start = ${start}`;
      }
      Deno.env.set("FADEBOT_LONGSHOT_WINDOW_SEC", String(body.windowSec ?? 300));
      const ref = Number(body.ref);
      await savePeriod(start - 60, start, Array.from({ length: 30 }, (_, i) => ({ t: start - 30 + i, p: ref })), "test");
      const msg = await longshotRun(start, Math.floor((now - start) / 60), now + Number(body.watch ?? 6));
      return json({
        msg,
        start,
        trades: await db()`select * from fadebot_trades where window_start = ${start} and strategy = 'longshot'`,
        signal: (await db()`select * from fadebot_longshot where window_start = ${start}`)[0] ?? null,
      });
    }
    if (body?.action === "test-trader" && env("FADEBOT_ALLOW_TEST") === "1") {
      // Give the current window this candle open, then run the trader for a few seconds.
      await setup();
      const now = Date.now() / 1000;
      const start = Math.floor(now / TF) * TF;
      if (body.reset) {
        await db()`delete from fadebot_trades where window_start = ${start}`;
        await db()`delete from fadebot_asks where window_start = ${start}`;
      }
      const open = Number(body.open);
      await savePeriod(start - 60, start, Array.from({ length: 30 }, (_, i) => ({ t: start - 30 + i, p: open })), "test");
      const msg = await traderRun(start, Math.floor((now - start) / 60), now + Number(body.watch ?? 6));
      return json({
        msg,
        start,
        trades: await db()`select * from fadebot_trades where window_start = ${start} order by id`,
        asks: await db()`select at_sec, p_up, action, up_cost, down_cost, pos_side, unrealized, did, ms from fadebot_asks
          where window_start = ${start} order by id`,
      });
    }
    if (body?.action === "test-exits" && env("FADEBOT_ALLOW_TEST") === "1") {
      await setup();
      await watchExits(Date.now() / 1000 + Number(body.watch ?? 5));
      const r = await db()`select * from fadebot_bets5 where window_start = ${Number(body.start)}`;
      return json({ bet: r[0] ?? null, state: (await db()`select * from fadebot_state5 where id = 1`)[0] });
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
