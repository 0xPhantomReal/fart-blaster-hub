import { describe, expect, it } from "vitest";
import * as bot from "../../supabase/functions/_shared/jevContext";
import { marketContext } from "./context";
import {
  addTrade,
  emptyFootprint,
  flowContext,
  flowSoFar,
  loadTradeHistory,
  niceStep,
  type Footprint,
} from "./orderflow";

// The Polymarket bot must send Jev exactly what the website sends.
const TF = 300;
const candles = Array.from({ length: 2300 }, (_, i) => {
  const o = 100000 + Math.sin(i / 37) * 900 + Math.cos(i / 5) * 120;
  const c = o + Math.sin(i * 1.7) * 80;
  return { time: 1_790_000_000 - (1_790_000_000 % TF) + i * TF, open: o, high: Math.max(o, c) + 30, low: Math.min(o, c) - 25, close: c };
});
const forTime = candles[2200].time;

function fps(lib: { emptyFootprint: typeof emptyFootprint; addTrade: typeof addTrade }) {
  const m = new Map<number, Footprint>();
  for (let i = 2170; i <= 2200; i++) {
    const t0 = candles[i].time;
    const fp = lib.emptyFootprint(t0, niceStep(150));
    for (let k = 0; k < 60; k++) lib.addTrade(fp, candles[i].open + ((k * 37) % 90) - 40, 0.01 + (k % 7) / 100, (k * i) % 3 !== 0, t0 + k * 4.9);
    m.set(t0, fp);
  }
  return m;
}

describe("bot context = website context", () => {
  it("market context, order flow and flow so far match", () => {
    const volume = new Map(candles.map((c, i) => [c.time, 10 + (i % 13)]));
    const x = { closed: candles, forTime, tfSeconds: TF, atr: 150, market: "btc", volume };
    expect(bot.marketContext(x)).toEqual(marketContext(x));
    expect(bot.niceStep(173)).toBe(niceStep(173));
    const a = fps({ emptyFootprint, addTrade });
    const b = fps({ emptyFootprint: bot.emptyFootprint, addTrade: bot.addTrade });
    expect(b).toEqual(a);
    expect(bot.flowContext(candles, b, forTime, TF, 150)).toEqual(flowContext(candles, a, forTime, TF, 150));
    const prev = (m: Map<number, Footprint>) => [1, 2, 3, 4, 5, 6].map((k) => m.get(forTime - k * TF));
    expect(bot.flowSoFar(b.get(forTime), 180, prev(b))).toEqual(flowSoFar(a.get(forTime), 180, prev(a)));
    expect(flowSoFar(a.get(forTime), 180, prev(a))).not.toBeNull();
  });

  it("trade history paging matches", async () => {
    const trades = Array.from({ length: 5000 }, (_, i) => [1000 + i * 0.5, 100 + i, 1, i % 2, i + 1] as [number, number, number, number, number]);
    const page = async (after: number | null) => {
      const hi = after === null ? 5000 : after - 1;
      const sl = trades.filter((t) => t[4] <= hi && t[4] > hi - 1000);
      return { trades: sl, minId: sl.length ? Math.min(...sl.map((t) => t[4])) : null, maxId: sl.length ? Math.max(...sl.map((t) => t[4])) : null };
    };
    const got1: number[] = [];
    const got2: number[] = [];
    await loadTradeHistory(page, 1500, 3000, (t) => got1.push(t.t), () => {});
    await bot.loadTradeHistory(page, 1500, 3000, (t) => got2.push(t.t), () => {});
    expect(got2.sort()).toEqual(got1.sort());
    expect(got1.length).toBe(3000);
  });
});
