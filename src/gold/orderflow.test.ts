import { describe, expect, it } from "vitest";
import { addTrade, emptyFootprint, flowContext, loadTradeHistory, niceStep, poc, summarize, type Trade } from "./orderflow";
import type { Candle } from "./indicators";

describe("order flow", () => {
  it("builds a footprint with aggressive buy/sell per level", () => {
    const fp = emptyFootprint(0, 5);
    addTrade(fp, 101, 2, true);
    addTrade(fp, 103, 1, false);
    addTrade(fp, 107, 4, true);
    expect(fp.buy).toBe(6);
    expect(fp.sell).toBe(1);
    expect(fp.levels["100.00000000"]).toEqual([2, 1]);
    expect(poc(fp)).toBe(107.5);
    const s = summarize(fp, { time: 0, open: 100, high: 110, low: 100, close: 109 }, 5)!;
    expect(s.delta_share).toBeCloseTo(5 / 7, 2);
    expect(niceStep(120)).toBe(10);
    expect(niceStep(0.003)).toBe(0.00025);
  });

  it("gives Jev order flow only from candles before the one asked about", () => {
    const cs: Candle[] = Array.from({ length: 30 }, (_, i) => ({ time: i * 60, open: 100, high: 102, low: 99, close: 101 }));
    const fps = new Map(cs.map((c) => {
      const f = emptyFootprint(c.time, 1);
      addTrade(f, 100.5, 3, true);
      addTrade(f, 101.5, 1, false);
      return [c.time, f];
    }));
    const ctx = flowContext(cs, fps, 25 * 60, 60, 2)!;
    expect(ctx.cumulative_delta_share_last_20).toBe(0.5);
    expect((ctx.delta_share_last_6 as number[]).length).toBe(6);
    expect(flowContext(cs, new Map(), 25 * 60, 60, 2)).toBeNull();
  });

  it("pages trade history back to a start time without double counting", async () => {
    // 50,000 fake trades, one per second, ids 1..50000.
    const N = 50_000;
    const T0 = 1_000_000;
    const page = async (after: number | null) => {
      const hi = (after ?? N + 1) - 1;
      const lo = Math.max(1, hi - 999);
      const trades: [number, number, number, number, number][] = [];
      for (let id = hi; id >= lo; id--) trades.push([T0 + id, 100, 1, id % 2, id]);
      return { trades, minId: trades.length ? lo : null, maxId: trades.length ? hi : null };
    };
    const got: Trade[] = [];
    const ok = await loadTradeHistory(page, T0 + 20_000, T0 + 45_000, (t) => got.push(t), () => {});
    expect(ok).toBe(true);
    expect(got.length).toBe(25_000);
    expect(new Set(got.map((t) => t.t)).size).toBe(25_000);
  });
});
