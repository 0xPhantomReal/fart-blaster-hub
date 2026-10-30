// Where candles come from: the `gold` edge function (real Pyth data, keys held server-side)
// or an in-browser simulation when no backend is configured.

import type { Candle } from "./indicators";

export const TIMEFRAMES = [1, 5, 15] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** The markets the page can show. Bitcoin uses the CME CF Bitcoin Real Time Index (BRTI) live when available. */
export type Market = "gold" | "btc";
export const MARKETS: Record<Market, { label: string; pair: string; timeframes: Timeframe[]; simStart: number }> = {
  gold: { label: "Gold", pair: "XAU/USD", timeframes: [1, 5, 15], simStart: 4000 },
  btc: { label: "Bitcoin", pair: "BTC/USD · BRTI", timeframes: [5, 15], simStart: 100000 },
};
export const HISTORY_BARS = 3000;
/** Bars per request when fetching long history (Pyth answers ~6k bars comfortably). */
const CHUNK_BARS = 5760;

const FN_URL = import.meta.env.VITE_SUPABASE_URL ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gold` : "";
const ANON_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export const backendConfigured = () => FN_URL.length > 0;

const nowSec = () => Math.floor(Date.now() / 1000);

async function callFn<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ANON_KEY ? { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `backend ${res.status}`);
  return json as T;
}

/** Live tick stream health, shown on the page. */
export interface TickStatus {
  state: "connecting" | "streaming" | "fallback";
  detail: string;
  /** Where live ticks come from right now ("BRTI" or "Pyth"), and why if it's not the preferred one. */
  source?: string;
  note?: string | null;
}

export interface Feed {
  readonly name: string;
  readonly tfMin: number;
  readonly market: Market;
  readonly jev: boolean; // backend has a TypeSafe key
  /** Current time on this feed's clock, unix seconds. */
  now(): number;
  history(): Promise<Candle[]>;
  /** onBar(candle, closed). Returns a stop function. */
  start(onBar: (c: Candle, closed: boolean) => void, onError: (msg: string) => void, onTicks?: (s: TickStatus) => void): () => void;
}

// ── Live: Pyth via edge function ───────────────────────────────────────

interface HistoryResponse {
  candles: Candle[];
  jev: boolean;
}

export class LiveFeed implements Feed {
  readonly name = "Pyth";
  jev = false;
  private lastClosed = 0;
  private readonly tf: number;
  now = () => Date.now() / 1000;
  constructor(
    readonly market: Market = "gold",
    readonly tfMin: Timeframe = 15,
  ) {
    this.tf = tfMin * 60;
  }
  private bucket = (t: number) => Math.floor(t / this.tf) * this.tf;
  /** True while ticks come from BRTI: then the candles built from those ticks are the ones shown and scored. */
  private ticksRule = false;
  private tickCandles = new Map<number, { c: Candle; firstTickAt: number }>();

  private async fetchRange(from: number, to: number, resolution: number = this.tfMin): Promise<Candle[]> {
    const r = await callFn<HistoryResponse>({ action: "history", from, to, resolution, market: this.market });
    this.jev = r.jev;
    return r.candles;
  }

  async history(): Promise<Candle[]> {
    const to = nowSec();
    // Gold trades ~23h × 5 days, so ask for ~1.7× the wall-clock span.
    const all = await this.fetchRange(to - Math.round(HISTORY_BARS * this.tf * 1.7), to);
    const closed = all.filter((c) => c.time < this.bucket(to)).slice(-HISTORY_BARS);
    this.lastClosed = closed.length ? closed[closed.length - 1].time : 0;
    return closed;
  }

  /**
   * Long history (closed only), fetched in chunks: ~a year of 15m, ~4 months of 5m, ~25 days of 1m (about 35k
   * candles each). Trains the model and is the pool for forecast analogs.
   */
  async deepHistory(): Promise<Candle[]> {
    const days = this.tfMin === 15 ? 365 : this.tfMin === 5 ? 120 : 25;
    const end = this.bucket(nowSec());
    const chunk = CHUNK_BARS * this.tf;
    const out: Candle[] = [];
    for (let from = end - days * 86400; from < end; from += chunk) {
      try {
        out.push(...(await this.fetchRange(from, Math.min(end, from + chunk))));
      } catch {
        // older data may not exist; use whatever comes back
      }
    }
    const seen = new Set<number>();
    return out.filter((c) => c.time < end && !seen.has(c.time) && seen.add(c.time)).sort((a, b) => a.time - b.time);
  }

  /** 1-minute candles for the last `days` days (2-day chunks). Used to replay Jev's flip read on past candles. */
  async minuteHistory(days = 3): Promise<Candle[]> {
    const end = Math.floor(nowSec() / 60) * 60;
    const out: Candle[] = [];
    for (let from = end - days * 86400; from < end; from += 2 * 86400) {
      out.push(...(await this.fetchRange(from, Math.min(end, from + 2 * 86400), 1)));
    }
    const seen = new Set<number>();
    return out.filter((m) => !seen.has(m.time) && seen.add(m.time)).sort((a, b) => a.time - b.time);
  }

  start(
    onBar: (c: Candle, closed: boolean) => void,
    onError: (msg: string) => void,
    onTicks: (s: TickStatus) => void = () => {},
  ): () => void {
    let stopped = false;
    let forming: Candle | null = null;
    let busy = false;

    const emitForming = () => forming && onBar({ ...forming }, false);

    // Closed candles (authoritative OHLC) come from the history API (every 5 s; every 2 s on 1-minute candles).
    const poll = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const now = nowSec();
        const recent = await this.fetchRange(Math.max(this.lastClosed, now - 10 * this.tf), now);
        const current = this.bucket(now);
        for (const c of recent) {
          if (c.time <= this.lastClosed) continue;
          if (c.time < current) {
            // Live BRTI candles that were streamed from their open are kept as streamed (history is Pyth's).
            const tc = this.tickCandles.get(c.time);
            onBar(this.ticksRule && tc && tc.firstTickAt - c.time <= 5 ? tc.c : c, true);
            this.tickCandles.delete(c.time);
            this.lastClosed = c.time;
          } else if (!forming || forming.time !== c.time) {
            forming = { ...c };
            emitForming();
          } else if (!this.ticksRule) {
            // Keep the API's open; widen high/low with anything the ticks saw.
            forming = { ...forming, open: c.open, high: Math.max(forming.high, c.high), low: Math.min(forming.low, c.low) };
            emitForming();
          }
        }
      } catch (e) {
        onError((e as Error).message);
      } finally {
        busy = false;
      }
    };

    let lastTickAt = 0;
    let streamDown = false;

    // Every Pyth price tick updates the forming candle.
    let reported: TickStatus["state"] | null = null;
    let tickSource: { source: string; note: string | null } = { source: "Pyth", note: null };
    const report = (st: TickStatus) => {
      if (st.state === reported && st.state === "streaming") return;
      reported = st.state;
      onTicks({ ...st, ...tickSource });
    };
    const onTick = (t: number, p: number) => {
      lastTickAt = Date.now();
      report({ state: "streaming", detail: tickSource.source === "BRTI" ? "every BRTI value (CF Benchmarks via Kalshi)" : "every Pyth price update" });
      const b = this.bucket(t);
      if (b <= this.lastClosed) return;
      if (!forming || b > forming.time) {
        forming = { time: b, open: forming ? forming.close : p, high: p, low: p, close: p };
        this.tickCandles.set(b, { c: { ...forming }, firstTickAt: t });
        if (this.tickCandles.size > 50) this.tickCandles.delete(this.tickCandles.keys().next().value!);
        void poll(); // a candle just closed: fetch its final OHLC now
      } else if (b < forming.time) {
        return; // late tick from the previous candle
      } else {
        forming.high = Math.max(forming.high, p);
        forming.low = Math.min(forming.low, p);
        forming.close = p;
        const tc = this.tickCandles.get(b);
        if (tc) tc.c = { ...forming };
      }
      emitForming();
    };

    let abort: AbortController | null = null;
    const stream = async () => {
      let backoff = 1000;
      report({ state: "connecting", detail: "opening the Pyth tick stream" });
      while (!stopped) {
        abort = new AbortController();
        try {
          const res = await fetch(FN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(ANON_KEY ? { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } : {}),
            },
            body: JSON.stringify({ action: "stream", market: this.market }),
            signal: abort.signal,
          });
          if (!res.ok || !res.body) {
            const j = await res.json().catch(() => ({}));
            throw new Error((j as { error?: string }).error ?? `tick stream ${res.status}`);
          }
          backoff = 1000;
          streamDown = false;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!line) continue;
              const m = JSON.parse(line) as { t?: number; p?: number; source?: string; note?: string | null };
              if (m.source) {
                // First line of each stream: where the ticks come from.
                this.ticksRule = m.source === "BRTI";
                tickSource = { source: m.source, note: m.note ?? null };
                reported = null;
                continue;
              }
              if (typeof m.t === "number" && typeof m.p === "number") onTick(m.t, m.p);
            }
          }
        } catch (e) {
          if (stopped) return;
          this.ticksRule = false;
          const msg = (e as Error).message;
          if (!streamDown) {
            streamDown = true;
            report({
              state: "fallback",
              detail: /unknown action/i.test(msg)
                ? "the backend isn't deployed yet (ask Lovable to “Deploy the gold edge function”)"
                : msg,
            });
          }
          await new Promise((r) => setTimeout(r, /unknown action/i.test(msg) ? 60_000 : backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };

    // Fallback while ticks aren't flowing: rebuild the forming candle from 1-minute candles.
    let minuteBusy = false;
    const minutePoll = async () => {
      if (stopped || minuteBusy || Date.now() - lastTickAt < 5000) return;
      minuteBusy = true;
      try {
        const now = nowSec();
        const current = this.bucket(now);
        const mins = (await this.fetchRange(current, now + 60, 1)).filter((m) => m.time >= current);
        if (!mins.length || current <= this.lastClosed) return;
        if (forming && current > forming.time) void poll(); // previous candle just closed
        const open = forming && forming.time === current ? forming.open : mins[0].open;
        forming = {
          time: current,
          open,
          high: Math.max(...mins.map((m) => m.high), forming && forming.time === current ? forming.high : -Infinity),
          low: Math.min(...mins.map((m) => m.low), forming && forming.time === current ? forming.low : Infinity),
          close: mins[mins.length - 1].close,
        };
        emitForming();
      } catch {
        // the main poll reports data errors
      } finally {
        minuteBusy = false;
      }
    };

    // Connected but silent (wrong feed, or nothing flowing): say so; the 1-minute fallback keeps the candle moving.
    const watchdog = window.setInterval(() => {
      if (stopped) return;
      if (Date.now() - lastTickAt > 20_000 && reported !== "fallback")
        report({ state: "fallback", detail: lastTickAt ? "ticks stopped arriving" : "no ticks have arrived" });
    }, 5000);

    void poll();
    void stream();
    const id = window.setInterval(poll, this.tfMin === 1 ? 2000 : 5000);
    const mid = window.setInterval(minutePoll, 2000);
    return () => {
      stopped = true;
      window.clearInterval(id);
      window.clearInterval(mid);
      window.clearInterval(watchdog);
      abort?.abort();
    };
  }
}

/** Jev's answers for one candle: its own chance of green, and its fact-check score (0–3) of the model's call. */
export interface CheckResult {
  pGreen: number;
  support: number | null;
  confidence: number | null;
}

/** Ask Jev about the candle opening at `forTime`. Cached per candle on the backend, so viewers share one answer. */
export async function askCheck(snapshot: unknown, forTime: number, timeframeMin: number, market: Market): Promise<CheckResult> {
  return callFn<CheckResult>({ action: "check", snapshot, forTime, timeframeMin, market });
}

/** Jev picks the most likely of the forecast paths (`options`: id → compact text). One answer per candle, shared. */
export async function askForecast(
  data: unknown,
  options: Record<string, string>,
  forTime: number,
  timeframeMin: number,
  market: Market,
): Promise<{ choice: string; probabilities: Record<string, number> }> {
  return callFn({ action: "forecast", data, options, forTime, timeframeMin, market });
}

export interface TickCheck {
  ok: boolean;
  host: string | null;
  feedId: string | null;
  feedSource: "secret" | "lookup" | "fallback" | null;
  firstPrice: number | null;
  problems: string[];
  brti?: { ok: boolean; problem: string | null };
}

/** Ask the backend to test the Pyth tick stream end to end and say exactly what's wrong. */
export async function tickCheck(market: Market): Promise<TickCheck> {
  return callFn<TickCheck>({ action: "tickcheck", market });
}

/** Jev: will the forming candle flip color before it closes? Shared per time slot on the backend. */
export async function askFlip(
  state: Record<string, unknown>,
  slotKey: string,
  timeframeMin: number,
  market: Market,
): Promise<{ pFlip: number }> {
  return callFn<{ pFlip: number }>({ action: "flip", state, slotKey, timeframeMin, market });
}

/** Which backend is deployed (older versions answer "unknown action"). */
export async function backendVersion(): Promise<{ version: number; features: string[] } | null> {
  try {
    return await callFn<{ version: number; features: string[] }>({ action: "version" });
  } catch (e) {
    if (/unknown action/i.test((e as Error).message)) return null;
    throw e;
  }
}

// ── Simulated gold (no backend needed) ─────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimFeed implements Feed {
  readonly name = "Simulated";
  readonly jev = false;
  private readonly tf: number;
  constructor(
    readonly market: Market = "gold",
    readonly tfMin: Timeframe = 15,
  ) {
    this.tf = tfMin * 60;
    this.price = MARKETS[market].simStart;
  }
  private bucket = (t: number) => Math.floor(t / this.tf) * this.tf;
  private price: number;
  private simNow = Date.now() / 1000;
  now = () => this.simNow;
  private rand = mulberry32(42);

  private step(): number {
    this.price += (this.rand() - 0.5) * 0.0003 * this.price;
    return Number(this.price.toFixed(2));
  }

  async history(): Promise<Candle[]> {
    const end = this.bucket(nowSec());
    const out: Candle[] = [];
    for (let i = HISTORY_BARS; i > 0; i--) {
      const open = Number(this.price.toFixed(2));
      let high = open, low = open, close = open;
      for (let k = 0; k < 30; k++) {
        close = this.step();
        high = Math.max(high, close);
        low = Math.min(low, close);
      }
      out.push({ time: end - i * this.tf, open, high, low, close });
    }
    return out;
  }

  start(onBar: (c: Candle, closed: boolean) => void): () => void {
    // Time runs fast: a candle closes every ~10s.
    const ticksPerBar = 40;
    let ticks = 0;
    let barTime = this.bucket(nowSec());
    let f: Candle | null = null;
    const id = window.setInterval(() => {
      const p = this.step();
      if (!f) f = { time: barTime, open: p, high: p, low: p, close: p };
      f.high = Math.max(f.high, p);
      f.low = Math.min(f.low, p);
      f.close = p;
      ticks += 1;
      this.simNow = barTime + (ticks / ticksPerBar) * this.tf;
      if (ticks >= ticksPerBar) {
        onBar({ ...f }, true);
        ticks = 0;
        barTime += this.tf;
        f = null;
      } else {
        onBar({ ...f }, false);
      }
    }, 250);
    return () => window.clearInterval(id);
  }
}
