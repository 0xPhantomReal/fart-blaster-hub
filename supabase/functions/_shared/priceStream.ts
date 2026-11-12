/**
 * Live best bid/ask for one Polymarket US market, pushed over the SDK's markets websocket.
 *
 * Used only when FADEBOT_PRICE_FEED=ws. The bot still falls back to its REST price calls whenever the stream has
 * no price, its price is older than `maxAgeMs`, or the socket never connected, so turning it on can't leave the bot
 * without prices.
 */

/** The parts of the SDK's MarketsWebSocket this uses. */
export interface MarketsSocket {
  on(event: string, listener: (...args: any[]) => void): unknown;
  connect(): Promise<void>;
  subscribeMarketDataLite(requestId: string, marketSlugs: string[]): void;
  close(): void;
}

export type StreamQuote = { bid: number | null; ask: number | null; at: number };

const num = (x: unknown): number | null => {
  const v = typeof x === "object" && x !== null ? (x as { value?: unknown }).value : x;
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isFinite(n) ? n : null;
};

export class PriceStream {
  latest: StreamQuote | null = null;
  updates = 0;
  error = "";
  connected = false;
  private sock: MarketsSocket | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly slug: string, private readonly now: () => number = Date.now) {}

  /** Connect and subscribe. Never throws: a failure is kept in `error` and the bot keeps polling. */
  async open(make: () => MarketsSocket, timeoutMs = 5000): Promise<boolean> {
    try {
      const s = make();
      s.on("marketDataLite", (m: { marketDataLite?: Record<string, unknown> }) => this.take(m?.marketDataLite));
      s.on("error", (e: unknown) => {
        this.error = e instanceof Error ? e.message : String(e);
      });
      s.on("close", () => {
        this.connected = false;
        this.wake();
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        s.connect(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`no connection after ${timeoutMs / 1000}s`)), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      s.subscribeMarketDataLite(`fadebot-${this.slug}`, [this.slug]);
      this.sock = s;
      this.connected = true;
      return true;
    } catch (e) {
      // The SDK reports a refused connection as "WebSocket connection failed: [object Object]".
      this.error = ((e as Error).message || String(e)).replace(/:?\s*\[object \w+\]/, ": could not connect");
      return false;
    }
  }

  /** Take one pushed update. A side missing from the message keeps its last price. */
  take(d: Record<string, unknown> | undefined) {
    if (!d || (d.marketSlug && d.marketSlug !== this.slug)) return;
    const bid = num(d.bestBid);
    const ask = num(d.bestAsk);
    if (bid === null && ask === null) return;
    this.latest = {
      bid: bid ?? this.latest?.bid ?? null,
      ask: ask ?? this.latest?.ask ?? null,
      at: this.now(),
    };
    this.updates++;
    this.wake();
  }

  /** The pushed price, if one arrived within `maxAgeMs`. */
  fresh(maxAgeMs: number): StreamQuote | null {
    if (!this.connected || !this.latest) return null;
    return this.now() - this.latest.at <= maxAgeMs ? this.latest : null;
  }

  /** Wait for the next pushed price, or `ms`, whichever comes first. */
  next(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.waiters = self.waiters.filter((w) => w !== done);
        resolve();
      }
      this.waiters.push(done);
    });
  }

  close() {
    this.connected = false;
    try {
      this.sock?.close();
    } catch {
      // already closed
    }
    this.sock = null;
    this.wake();
  }

  private wake() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}
