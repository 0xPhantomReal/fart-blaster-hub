// Where candles come from: the `gold` edge function (real Pyth data, keys held server-side)
// or an in-browser simulation when no backend is configured.

import type { Candle } from "./indicators";

export const TIMEFRAME_MIN = 15;
export const TF_SECONDS = TIMEFRAME_MIN * 60;
export const HISTORY_BARS = 3000;

const FN_URL = import.meta.env.VITE_SUPABASE_URL ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gold` : "";
const ANON_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export const backendConfigured = () => FN_URL.length > 0;

const bucket = (t: number) => Math.floor(t / TF_SECONDS) * TF_SECONDS;
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

export interface Feed {
  readonly name: string;
  readonly jev: boolean; // backend has a TypeSafe key
  history(): Promise<Candle[]>;
  /** onBar(candle, closed). Returns a stop function. */
  start(onBar: (c: Candle, closed: boolean) => void, onError: (msg: string) => void): () => void;
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

  private async fetchRange(from: number, to: number): Promise<Candle[]> {
    const r = await callFn<HistoryResponse>({ action: "history", from, to, resolution: TIMEFRAME_MIN });
    this.jev = r.jev;
    return r.candles;
  }

  async history(): Promise<Candle[]> {
    const to = nowSec();
    // Gold trades ~23h × 5 days, so ask for ~1.7× the wall-clock span.
    const all = await this.fetchRange(to - Math.round(HISTORY_BARS * TF_SECONDS * 1.7), to);
    const closed = all.filter((c) => c.time < bucket(to)).slice(-HISTORY_BARS);
    this.lastClosed = closed.length ? closed[closed.length - 1].time : 0;
    return closed;
  }

  start(onBar: (c: Candle, closed: boolean) => void, onError: (msg: string) => void): () => void {
    let stopped = false;
    let forming: Candle | null = null;
    let busy = false;

    const emitForming = () => forming && onBar({ ...forming }, false);

    // Closed candles (authoritative OHLC) come from the history API.
    const poll = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const now = nowSec();
        const recent = await this.fetchRange(Math.max(this.lastClosed, now - 10 * TF_SECONDS), now);
        const current = bucket(now);
        for (const c of recent) {
          if (c.time <= this.lastClosed) continue;
          if (c.time < current) {
            onBar(c, true);
            this.lastClosed = c.time;
          } else if (!forming || forming.time !== c.time) {
            forming = { ...c };
            emitForming();
          } else {
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

    // Every Pyth price tick updates the forming candle.
    const onTick = (t: number, p: number) => {
      const b = bucket(t);
      if (b <= this.lastClosed) return;
      if (!forming || b > forming.time) {
        forming = { time: b, open: forming ? forming.close : p, high: p, low: p, close: p };
        void poll(); // a candle just closed: fetch its final OHLC now
      } else if (b < forming.time) {
        return; // late tick from the previous candle
      } else {
        forming.high = Math.max(forming.high, p);
        forming.low = Math.min(forming.low, p);
        forming.close = p;
      }
      emitForming();
    };

    let abort: AbortController | null = null;
    const stream = async () => {
      let backoff = 1000;
      while (!stopped) {
        abort = new AbortController();
        try {
          const res = await fetch(FN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(ANON_KEY ? { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } : {}),
            },
            body: JSON.stringify({ action: "stream" }),
            signal: abort.signal,
          });
          if (!res.ok || !res.body) {
            const j = await res.json().catch(() => ({}));
            throw new Error((j as { error?: string }).error ?? `tick stream ${res.status}`);
          }
          backoff = 1000;
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
              const m = JSON.parse(line) as { t: number; p: number };
              onTick(m.t, m.p);
            }
          }
        } catch (e) {
          if (stopped) return;
          onError(`ticks: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };

    void poll();
    void stream();
    const id = window.setInterval(poll, 5000);
    return () => {
      stopped = true;
      window.clearInterval(id);
      abort?.abort();
    };
  }
}

export interface JevVerdict {
  choice: "green" | "red";
  probGreen: number;
  confidence: number;
}

export async function askJev(snapshot: Record<string, unknown>): Promise<JevVerdict> {
  return callFn<JevVerdict>({ action: "jev", snapshot, timeframeMin: TIMEFRAME_MIN });
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
  private price = 4000;
  private rand = mulberry32(42);

  private step(): number {
    this.price += (this.rand() - 0.5) * 1.2;
    return Number(this.price.toFixed(2));
  }

  async history(): Promise<Candle[]> {
    const end = bucket(nowSec());
    const out: Candle[] = [];
    for (let i = HISTORY_BARS; i > 0; i--) {
      const open = Number(this.price.toFixed(2));
      let high = open, low = open, close = open;
      for (let k = 0; k < 30; k++) {
        close = this.step();
        high = Math.max(high, close);
        low = Math.min(low, close);
      }
      out.push({ time: end - i * TF_SECONDS, open, high, low, close });
    }
    return out;
  }

  start(onBar: (c: Candle, closed: boolean) => void): () => void {
    // Time runs fast: a candle closes every ~10s.
    const ticksPerBar = 40;
    let ticks = 0;
    let barTime = bucket(nowSec());
    let f: Candle | null = null;
    const id = window.setInterval(() => {
      const p = this.step();
      if (!f) f = { time: barTime, open: p, high: p, low: p, close: p };
      f.high = Math.max(f.high, p);
      f.low = Math.min(f.low, p);
      f.close = p;
      ticks += 1;
      if (ticks >= ticksPerBar) {
        onBar({ ...f }, true);
        ticks = 0;
        barTime += TF_SECONDS;
        f = null;
      } else {
        onBar({ ...f }, false);
      }
    }, 250);
    return () => window.clearInterval(id);
  }
}
