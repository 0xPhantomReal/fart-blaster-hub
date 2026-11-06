import { describe, expect, it } from "vitest";
import { Ema } from "./indicators";
import { emaSeries, rsiSeries, runTvIndicator, tvContext } from "./tvIndicator";
import * as bot from "../../supabase/functions/_shared/tvIndicator";

describe("TradingView indicator port", () => {
  it("RSI matches the textbook Wilder example (StockCharts example, computed without its rounding)", () => {
    const c = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
    ];
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
    const candles = Array.from({ length: 60 }, (_, i) => ({
      time: i * 300,
      open: 100 + i,
      high: 101.5 + i,
      low: 99.5 + i,
      close: 101 + i,
    }));
    const r = runTvIndicator(candles, null);
    expect(r.bars[10].probUp).toBeNull(); // RSI not ready yet → na → no call
    expect(r.bars[10].bias).toBe(0);
    // all green: RSI 100 → mean revert −0.5, momentum +0.6, trend +0.6, close loc 0.75 → +0.15, exhaustion −0.3,
    // stretch = (close − emaFast)/atr clamped → extension; probUp = logistic(score)
    const last = r.bars[59];
    expect(last.probUp!).toBeGreaterThan(0.5);
    expect(r.greens).toBe(60);
    expect(r.bars_).toBe(60);
    expect(r.calls).toBe(
      r.bars.slice(0, -1).filter((b) => b.bias !== 0).length,
    );
    expect(r.hits).toBe(r.bars.slice(0, -1).filter((b) => b.bias === 1).length); // every up call hit
    expect(r.pShow).toBe(last.probUp);
  });

  it("the bot's copy gives identical results", () => {
    const candles = Array.from({ length: 3000 }, (_, i) => {
      const o = 100000 + Math.sin(i / 23) * 700 + Math.cos(i / 4) * 90;
      const c = o + Math.sin(i * 1.3) * 60;
      return {
        time: i * 900,
        open: o,
        high: Math.max(o, c) + 20,
        low: Math.min(o, c) - 15,
        close: c,
      };
    });
    expect(bot.runTvIndicator(candles, null)).toEqual(
      runTvIndicator(candles, null),
    );
  });

  it("Jev's indicator block: same in the bot, only closed candles before the read, live EMAs", () => {
    const candles = Array.from({ length: 2500 }, (_, i) => {
      const o = 100000 + Math.sin(i / 19) * 500;
      const c = o + Math.cos(i * 0.9) * 40;
      return {
        time: i * 300,
        open: o,
        high: Math.max(o, c) + 10,
        low: Math.min(o, c) - 10,
        close: c,
      };
    });
    const t = 2400 * 300;
    const a = tvContext(candles, t, 300, 100123.45);
    expect(bot.tvContext(candles, t, 300, 100123.45)).toEqual(a);
    expect(a!.candles_counted).toBe(2000); // the last 2,000 closed before the read
    // later candles don't leak in
    expect(tvContext(candles.slice(0, 2400), t, 300, 100123.45)).toEqual(a);
    expect(tvContext(candles, t, 300, null)!.ema_values_are).toBe(
      "at the last close",
    );
  });
});
