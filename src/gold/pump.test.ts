import { describe, expect, it } from "vitest";
import {
  btcVolPerSec,
  feePerShare,
  MarketTape,
  pumpCandidate,
  pumpExit,
  pumpFeatures,
  pumpScore,
  sideBooks,
  walkBuy,
  walkSell,
} from "../../supabase/functions/_shared/pumpCore";

const cfg = { maxAsk: 0.3, minAsk: 0.02, tp: 1, sl: 0.5, exitSec: 10, minLeft: 45 };

describe("pump bot: books", () => {
  it("derives the NO side from the YES book", () => {
    const b = sideBooks([[0.75, 10], [0.74, 5]], [[0.77, 8], [0.8, 3]], "up");
    expect(b.up.asks[0]).toEqual([0.77, 8]);
    expect(b.up.bids[0]).toEqual([0.75, 10]);
    // Down buys from YES bids (1 − 0.75 = 25¢) and sells into YES offers (1 − 0.77 = 23¢).
    expect(b.down.asks[0]).toEqual([0.25, 10]);
    expect(b.down.asks[1]).toEqual([0.26, 5]);
    expect(b.down.bids[0]).toEqual([0.23, 8]);
  });
  it("swaps sides when YES pays on Down", () => {
    const b = sideBooks([[0.75, 10]], [[0.77, 8]], "down");
    expect(b.down.asks[0]).toEqual([0.77, 8]);
    expect(b.up.asks[0]).toEqual([0.25, 10]);
  });
  it("walks the book to fill a dollar buy and a share sell", () => {
    const w = walkBuy([[0.2, 3], [0.25, 100]], 1);
    expect(w!.shares).toBeCloseTo(3 + 0.4 / 0.25);
    expect(w!.price).toBeCloseTo(1 / 4.6);
    expect(walkBuy([[0.2, 1]], 1)).toBeNull();
    const s = walkSell([[0.4, 2], [0.38, 10]], 5);
    expect(s.sold).toBe(5);
    expect(s.proceeds).toBeCloseTo(0.8 + 3 * 0.38);
    expect(walkSell([[0.4, 2]], 5).sold).toBe(2);
  });
  it("fee is 0.095 p (1 − p)", () => {
    expect(feePerShare(0.2)).toBeCloseTo(0.0152);
  });
});

describe("pump bot: tape", () => {
  it("reads full books, trades by taker side, and keeps a price history", () => {
    let t = 1_000_000;
    const tape = new MarketTape("m", "up", () => t);
    tape.takeBook({ marketSlug: "m", bids: [{ px: { value: "0.80" }, qty: "50" }], offers: [{ px: { value: "0.82" }, qty: "40" }] });
    tape.takeTrade({ marketSlug: "m", price: { value: "0.81" }, quantity: { value: "10" }, taker: { intent: "ORDER_INTENT_BUY_SHORT" } });
    tape.takeTrade({ marketSlug: "m", price: { value: "0.81" }, quantity: { value: "4" }, taker: { intent: "ORDER_INTENT_BUY_LONG" } });
    tape.takeTrade({ marketSlug: "other", price: { value: "0.5" }, quantity: { value: "99" }, taker: { intent: "ORDER_INTENT_BUY_LONG" } });
    t += 5000;
    tape.takeBook({ marketSlug: "m", bids: [{ px: { value: "0.76" }, qty: "50" }], offers: [{ px: { value: "0.78" }, qty: "40" }] });
    const f = pumpFeatures(tape, "down", 120, { price: null, ref: null, ticks: [] }, t);
    expect(f.ask_c).toBe(24);
    expect(f.bid_c).toBe(22);
    expect(f.target_bid_c).toBe(48);
    expect(f.stop_bid_c).toBe(12);
    expect(f.flow_10s).toEqual({ trades: 2, buy_shares: 10, sell_shares: 4, net: 6 });
    expect(f.price_moves_30s).toMatchObject({ first_c: 20, high_c: 24, changes: 1 });
    expect(tape.hist.length).toBe(2);
  });
  it("ignores a lite quote once full books arrive", () => {
    const tape = new MarketTape("m", "up", () => 1);
    tape.takeLite({ bestBid: { value: "0.4" }, bestAsk: { value: "0.42" } });
    expect(tape.books().up.asks[0][0]).toBe(0.42);
    tape.takeBook({ bids: [{ px: 0.5, qty: 1 }], offers: [{ px: 0.52, qty: 1 }] });
    tape.takeLite({ bestBid: { value: "0.1" }, bestAsk: { value: "0.12" } });
    expect(tape.books().up.asks[0][0]).toBe(0.52);
  });
});

describe("pump bot: rules", () => {
  it("picks the cheapest side in range", () => {
    const b = sideBooks([[0.8, 1]], [[0.82, 1]], "up");
    expect(pumpCandidate(b, cfg)).toEqual({ side: "down", ask: 0.2 });
    expect(pumpCandidate(sideBooks([[0.5, 1]], [[0.52, 1]], "up"), cfg)).toBeNull();
    expect(pumpCandidate(sideBooks([[0.995, 1]], [[0.999, 1]], "up"), cfg)).toBeNull(); // 0.5¢: under min
  });
  it("exits at +100% / −50% on the bid, or on time", () => {
    expect(pumpExit(0.2, 0.4, 100, cfg)).toBe("take profit");
    expect(pumpExit(0.2, 0.39, 100, cfg)).toBeNull();
    expect(pumpExit(0.2, 0.1, 100, cfg)).toBe("stop loss");
    expect(pumpExit(0.2, 0.25, 9, cfg)).toBe("time");
    expect(pumpExit(0.2, null, 100, cfg)).toBeNull();
  });
  it("measures bitcoin volatility per √s", () => {
    const ticks: [number, number][] = Array.from({ length: 30 }, (_, i) => [100 + i, 50000 + (i % 2 ? 3 : 0)]);
    expect(btcVolPerSec(ticks, 130, 60)).toBeCloseTo(3);
    expect(btcVolPerSec(ticks.slice(0, 5), 130, 60)).toBeNull();
  });
});

describe("pump bot: microstructure score", () => {
  const book = (yesBid: number, yesAsk: number, bidQty = 40, askQty = 30) => ({
    marketSlug: "m",
    bids: [{ px: yesBid, qty: bidQty }, { px: yesBid - 0.01, qty: 100 }],
    offers: [{ px: yesAsk, qty: askQty }, { px: yesAsk + 0.01, qty: 100 }],
  });
  const buyDown = (q: number) => ({ marketSlug: "m", price: { value: "0.8" }, quantity: { value: String(q) }, taker: { intent: "ORDER_INTENT_BUY_SHORT" } });
  const sellDown = (q: number) => ({ marketSlug: "m", price: { value: "0.8" }, quantity: { value: String(q) }, taker: { intent: "ORDER_INTENT_BUY_LONG" } });

  it("is low on a quiet, heavy, falling book with BTC far away", () => {
    let t = 1_000_000;
    const tape = new MarketTape("m", "up", () => t);
    tape.takeBook(book(0.75, 0.77));
    t += 20_000;
    tape.takeBook(book(0.79, 0.81, 900, 5)); // down ask falls 25 → 21¢; 900 down shares offered, 5 bid
    tape.takeTrade(sellDown(50));
    const ticks: [number, number][] = Array.from({ length: 60 }, (_, i) => [t / 1000 - 60 + i, 100100 + (i % 2)]);
    const f = pumpFeatures(tape, "down", 100, { price: 100100, ref: 100000, ticks }, t);
    const sc = pumpScore(f, tape, t);
    expect(sc.parts.flow).toBe(0);
    expect(sc.parts.turn).toBe(0);
    expect(sc.parts.btc).toBe(0);
    expect(sc.score).toBeLessThan(30);
  });

  it("is high with buyers speeding up, thin offers, stacked bids, a turn up and BTC close", () => {
    let t = 1_000_000;
    const tape = new MarketTape("m", "up", () => t);
    tape.takeBook(book(0.78, 0.8, 40, 30)); // down ask 22¢
    t += 12_000;
    tape.takeBook(book(0.8, 0.82, 30, 30)); // down ask 20¢ (the low)
    t += 13_000;
    tape.takeBook(book(0.78, 0.8, 5, 400)); // down ask back to 22¢, down bids (YES offers) 400 deep vs 5 offers
    tape.takeTrade(buyDown(40));
    tape.takeTrade(buyDown(30));
    // BTC $6 under the price to beat (Down is ahead yet cheap) and falling over the last 10 s.
    const ticks: [number, number][] = Array.from({ length: 60 }, (_, i) => [t / 1000 - 60 + i, 100004 - (i >= 50 ? (i - 49) * 1 : 0) + (i % 2) * 2]);
    const f = pumpFeatures(tape, "down", 120, { price: 99994, ref: 100000, ticks }, t);
    const sc = pumpScore(f, tape, t);
    expect(sc.parts.flow).toBe(20);
    expect(sc.parts.thin).toBeGreaterThanOrEqual(18); // $24 of offers up to 2×
    expect(sc.parts.bids).toBeGreaterThanOrEqual(14);
    expect(sc.parts.turn).toBeGreaterThan(0);
    expect(sc.parts.btc).toBeGreaterThan(10);
    expect(sc.score).toBeGreaterThan(70);
  });
});
