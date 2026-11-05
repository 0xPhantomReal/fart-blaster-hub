import { describe, expect, it } from "vitest";
import { Ema } from "./indicators";
import { emaSeries, rsiSeries, runTvIndicator } from "./tvIndicator";

describe("TradingView indicator port", () => {
  it("RSI matches the textbook Wilder example (StockCharts example, computed without its rounding)", () => {
    const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0];
    const r = rsiSeries(c, 14);
    expect(r.slice(0, 14).every((x) => x === null)).toBe(true); // na until 14 changes
    expect(r[14]!).toBeCloseTo(70.464, 2);
    expect(r[15]!).toBeCloseTo(66.249, 2);
  });

  it("EMA is Pine's (SMA seed)", () => {
    const xs = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 3);
    const e = new Ema(9);
    expect(emaSeries(xs, 9)).toEqual(xs.map((x) => e.update(x)));
  });

  it("scores, calls and the track record", () => {
    // steady uptrend of green candles
    const candles = Array.from({ length: 60 }, (_, i) => ({ time: i * 300, open: 100 + i, high: 101.5 + i, low: 99.5 + i, close: 101 + i }));
    const r = runTvIndicator(candles, null);
    expect(r.bars[10].probUp).toBeNull(); // RSI not ready yet → na → no call
    expect(r.bars[10].bias).toBe(0);
    // all green: RSI 100 → mean revert −0.5, momentum +0.6, trend +0.6, close loc 0.75 → +0.15, exhaustion −0.3,
    // stretch = (close − emaFast)/atr clamped → extension; probUp = logistic(score)
    const last = r.bars[59];
    expect(last.probUp!).toBeGreaterThan(0.5);
    expect(r.greens).toBe(60);
    expect(r.bars_).toBe(60);
    expect(r.calls).toBe(r.bars.slice(0, -1).filter((b) => b.bias !== 0).length);
    expect(r.hits).toBe(r.bars.slice(0, -1).filter((b) => b.bias === 1).length); // every up call hit
    expect(r.pShow).toBe(last.probUp);
  });
});
