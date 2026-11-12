import { describe, expect, it } from "vitest";
import { PriceStream, type MarketsSocket } from "../../supabase/functions/_shared/priceStream";

class FakeSocket implements MarketsSocket {
  handlers: Record<string, ((...a: any[]) => void)[]> = {};
  subs: string[][] = [];
  closed = false;
  constructor(private fail = false) {}
  on(e: string, f: (...a: any[]) => void) {
    (this.handlers[e] ??= []).push(f);
    return this;
  }
  emit(e: string, ...a: any[]) {
    for (const f of this.handlers[e] ?? []) f(...a);
  }
  connect() {
    return this.fail ? Promise.reject(new Error("401 unauthorized")) : Promise.resolve();
  }
  subscribeMarketDataLite(_id: string, slugs: string[]) {
    this.subs.push(slugs);
  }
  close() {
    this.closed = true;
  }
}

describe("PriceStream", () => {
  it("subscribes to the market and keeps the latest pushed bid/ask", async () => {
    let now = 1000;
    const sock = new FakeSocket();
    const s = new PriceStream("btc-5m", () => now);
    expect(await s.open(() => sock)).toBe(true);
    expect(sock.subs).toEqual([["btc-5m"]]);
    expect(s.fresh(3000)).toBeNull();
    sock.emit("marketDataLite", { marketDataLite: { marketSlug: "btc-5m", bestBid: { value: "0.41" }, bestAsk: { value: "0.43" } } });
    expect(s.fresh(3000)).toEqual({ bid: 0.41, ask: 0.43, at: 1000 });
    // a one-sided update keeps the other side
    now = 1500;
    sock.emit("marketDataLite", { marketDataLite: { marketSlug: "btc-5m", bestAsk: { value: "0.6" } } });
    expect(s.fresh(3000)).toEqual({ bid: 0.41, ask: 0.6, at: 1500 });
    // other markets are ignored
    sock.emit("marketDataLite", { marketDataLite: { marketSlug: "eth-5m", bestAsk: { value: "0.9" } } });
    expect(s.fresh(3000)?.ask).toBe(0.6);
    // stale prices aren't used
    now = 5000;
    expect(s.fresh(3000)).toBeNull();
    expect(s.updates).toBe(2);
  });

  it("wakes a waiting check as soon as a price is pushed", async () => {
    const sock = new FakeSocket();
    const s = new PriceStream("m");
    await s.open(() => sock);
    const t0 = Date.now();
    const w = s.next(5000);
    setTimeout(() => sock.emit("marketDataLite", { marketDataLite: { bestBid: "0.5" } }), 20);
    await w;
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("reports a failed connection instead of throwing, and stops using prices after close", async () => {
    const bad = new PriceStream("m");
    expect(await bad.open(() => new FakeSocket(true))).toBe(false);
    expect(bad.error).toContain("401");
    const sock = new FakeSocket();
    const s = new PriceStream("m");
    await s.open(() => sock);
    sock.emit("marketDataLite", { marketDataLite: { bestBid: "0.5" } });
    expect(s.fresh(3000)).not.toBeNull();
    sock.emit("close");
    expect(s.fresh(3000)).toBeNull();
    s.close();
    expect(sock.closed).toBe(true);
  });
});
