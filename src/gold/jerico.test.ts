import { describe, expect, it } from "vitest";
import { candles, decode, flow, lastAt } from "./jerico";
import { TickRecorder } from "../../supabase/functions/_shared/tickTape";

describe("jerico tick recorder → chart data", () => {
  it("records only book changes, trades by taker side, and flushes relative times", () => {
    let t = 1_000_000;
    const rec = new TickRecorder("m", () => t);
    rec.takeBook({ marketSlug: "m", bids: [{ px: { value: "0.60" }, qty: "10" }, { px: { value: "0.59" }, qty: "5" }], offers: [{ px: { value: "0.62" }, qty: "8" }] });
    t += 100;
    rec.takeBook({ marketSlug: "m", bids: [{ px: { value: "0.60" }, qty: "10" }], offers: [{ px: { value: "0.62" }, qty: "8" }] }); // same top: no tick
    t += 150;
    rec.takeTrade({ marketSlug: "m", price: { value: "0.62" }, quantity: { value: "3" }, taker: { intent: "ORDER_INTENT_BUY_LONG" } });
    t += 50;
    rec.takeBook({ marketSlug: "m", bids: [{ px: 0.61, qty: 4 }], offers: [{ px: 0.63, qty: 9 }] });
    rec.takeTrade({ marketSlug: "other", price: { value: "0.5" }, quantity: { value: "9" }, taker: { intent: "ORDER_INTENT_BUY_LONG" } });
    const c = rec.flush()!;
    expect(c.t0).toBe(1_000_000);
    expect(c.rows).toEqual([[0, 0, 0.6, 10, 0.62, 8], [250, 1, 0.62, 3, 1], [300, 0, 0.61, 4, 0.63, 9]]);
    expect(rec.flush()).toBeNull();
  });

  it("decodes YES ticks into the viewed side", () => {
    const chunks = [{ seq: 0, t0: 1000, rows: [[0, 0, 0.6, 10, 0.62, 8], [250, 1, 0.62, 3, 1]] }];
    const up = decode(chunks, "up", "up");
    expect(up.book[0]).toEqual({ t: 1000, bid: 0.6, ask: 0.62, bidSz: 10, askSz: 8 });
    expect(up.trades[0]).toEqual({ t: 1250, px: 0.62, qty: 3, takerBought: true });
    const down = decode(chunks, "up", "down");
    expect(down.book[0]).toEqual({ t: 1000, bid: 0.38, ask: 0.4, bidSz: 8, askSz: 10 });
    expect(down.trades[0]).toEqual({ t: 1250, px: 0.38, qty: 3, takerBought: false });
    // YES pays on Down: viewing Down is the YES book itself
    expect(decode(chunks, "down", "down").book[0].bid).toBe(0.6);
  });

  it("builds mid-price candles (carrying the close through quiet buckets) and taker flow", () => {
    const book = [
      { t: 0, bid: 0.5, ask: 0.52, bidSz: 1, askSz: 1 }, // mid .51
      { t: 400, bid: 0.54, ask: 0.56, bidSz: 1, askSz: 1 }, // .55
      { t: 2500, bid: 0.48, ask: 0.5, bidSz: 1, askSz: 1 }, // .49
    ];
    const cs = candles(book, 0, 3000, 1000);
    expect(cs.map((c) => [c.t, c.o, c.h, c.l, c.c])).toEqual([
      [0, 0.51, 0.55, 0.51, 0.55],
      [1000, 0.55, 0.55, 0.55, 0.55], // no ticks: flat at the last close
      [2000, 0.55, 0.55, 0.49, 0.49],
    ]);
    const f = flow([{ t: 100, px: 0.5, qty: 3, takerBought: true }, { t: 900, px: 0.5, qty: 1, takerBought: false }, { t: 1500, px: 0.5, qty: 2, takerBought: true }], 1000);
    expect(f).toEqual([{ t: 0, bought: 3, sold: 1 }, { t: 1000, bought: 2, sold: 0 }]);
    expect(lastAt(book, 401)).toBe(1);
    expect(lastAt(book, -1)).toBe(-1);
  });
});
