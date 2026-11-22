import { describe, expect, it } from "vitest";
import { takeCoinbase, takeHyperliquid, Venue } from "../../supabase/functions/_shared/btcFlow";
import { fairChance, MarketTape, snapRow } from "../../supabase/functions/_shared/pumpCore";

describe("btc order flow", () => {
  it("adds Cont OFI increments from top-of-book changes", () => {
    let t = 0;
    const v = new Venue("x", () => t);
    v.setTop({ bid: 100, bidSz: 5, ask: 101, askSz: 5 });
    t = 1000;
    v.setTop({ bid: 100, bidSz: 8, ask: 101, askSz: 5 }); // bid size +3 → +3
    t = 2000;
    v.setTop({ bid: 100, bidSz: 8, ask: 101, askSz: 2 }); // ask size −3 at same price → +3
    t = 5000;
    v.setTop({ bid: 99, bidSz: 4, ask: 100, askSz: 6 }); // bid drops (−8), ask improves (−6) → −14
    const s = v.stats(5000)!;
    expect(s.ofi_5s).toBe(3 + 3 - 14);
    expect(s.move_5s).toBe(-1);
  });
  it("reads Coinbase tickers and matches (maker side → taker direction)", () => {
    const v = new Venue("cb", () => 5000);
    takeCoinbase(v, { type: "ticker", best_bid: "100", best_bid_size: "3", best_ask: "100.5", best_ask_size: "1" });
    takeCoinbase(v, { type: "match", side: "sell", size: "0.5", price: "100.5" }); // taker bought
    takeCoinbase(v, { type: "match", side: "buy", size: "0.2", price: "100" }); // taker sold
    const s = v.stats(5000)!;
    expect(s.flow_5s).toEqual({ buy: 0.5, sell: 0.2, net: 0.3 });
    expect(s.top_imbalance).toBe(0.5);
    expect(s.micro_minus_mid).toBeGreaterThan(0); // bigger bid → microprice above mid
  });
  it("reads Hyperliquid books and trades", () => {
    const v = new Venue("hl", () => 1);
    takeHyperliquid(v, {
      channel: "l2Book",
      data: { levels: [[{ px: "100", sz: "2" }, { px: "99.95", sz: "4" }], [{ px: "100.1", sz: "1" }, { px: "101", sz: "9" }]] },
    });
    takeHyperliquid(v, { channel: "trades", data: [{ side: "B", sz: "0.3", px: "100.1" }, { side: "A", sz: "0.1", px: "100" }] });
    const s = v.stats(1)!;
    expect(s.depth10bps_imbalance).toBeCloseTo((6 - 1) / 7, 2);
    expect(s.flow_5s.net).toBeCloseTo(0.2);
  });
});

describe("fair chance from bitcoin", () => {
  it("is 50% at the price to beat, and falls with distance against the side", () => {
    expect(fairChance("up", 100000, 100000, 3, 200, null)!).toBeCloseTo(0.5, 2);
    const far = fairChance("up", 99950, 100000, 3, 200, null)!;
    const near = fairChance("up", 99990, 100000, 3, 200, null)!;
    expect(far).toBeLessThan(near);
    expect(fairChance("down", 99950, 100000, 3, 200, null)!).toBeCloseTo(1 - far, 5);
  });
  it("uses the locked part of the last-minute average", () => {
    // 50 s locked at 100,010 (above the 100,000 price to beat); BTC now 99,990 with 10 s left: Up still very likely.
    const p = fairChance("up", 99990, 100000, 3, 10, { sum: 100010 * 50, n: 50 })!;
    expect(p).toBeGreaterThan(0.9);
  });
});

describe("recorder row", () => {
  it("has fill prices for $10/$20 and the gap to fair", () => {
    let t = 1_000_000;
    const tape = new MarketTape("m", "up", () => t);
    tape.takeBook({ bids: [{ px: 0.8, qty: 20 }, { px: 0.78, qty: 200 }], offers: [{ px: 0.82, qty: 50 }] });
    t += 2000;
    const ticks: [number, number][] = Array.from({ length: 70 }, (_, i) => [t / 1000 - 70 + i, 100000 + (i % 2) * 4]);
    const r = snapRow(tape, "down", 150, { price: 100004, ref: 100000, ticks }, t / 1000 + 150, null, t);
    expect(r.ask).toBe(0.2);
    expect(r.fill10).toBeCloseTo(10 / (20 + 6 / 0.22), 3); // 20 shares at 20¢, then 22¢
    expect(r.fair).not.toBeNull();
    expect(r.gap).toBeCloseTo(r.fair! - r.fill10!, 4);
  });
});
