import { describe, expect, it } from "vitest";
import { backtest, Tv15 } from "./fadeBacktest";

// 15m candles: a steady uptrend → the indicator calls GREEN once warmed up
const c15 = Array.from({ length: 200 }, (_, i) => ({
  time: i * 900,
  open: 100 + i,
  high: 101.5 + i,
  low: 99.5 + i,
  close: 101 + i,
}));

describe("bot-rule backtest", () => {
  it("finds the indicator's call at a moment", () => {
    const tv = new Tv15(c15);
    expect(tv.at(0)).toBeNull(); // nothing closed yet
    expect(tv.at(150 * 900 + 30)).toBe(1);
  });

  it("bets only when Jev goes against the 15m indicator, with the indicator", () => {
    const tv = new Tv15(c15);
    const T = 150 * 900;
    const reads = [
      { time: T, pJev: 0.3, y: 1 as const }, //   Jev red 70% vs indicator green → bet green → win
      { time: T + 300, pJev: 0.35, y: 0 as const }, // Jev red vs green → bet green → loss
      { time: T + 600, pJev: 0.8, y: 1 as const }, //  Jev green agrees with indicator → skip
      { time: T + 900, pJev: 0.95, y: 0 as const }, // over 90% → out of range
      { time: T + 1200, pJev: 0.5, y: 1 as const }, // no call
      { time: T + 1500, pJev: 0.4, y: null }, //       flat candle
    ];
    const r = backtest(reads, tv, 30, 0.5, 0.9);
    expect(r.bot).toEqual({ n: 2, wins: 1 });
    expect(r.skippedAgree).toBe(1);
    expect(r.fadeAll).toEqual({ n: 3, wins: 1 }); // green, green, red bets → win, loss, loss
    expect(r.jevInRange).toEqual({ n: 3, wins: 2 });
    expect(r.tvAlone).toEqual({ n: 4, wins: 2 }); // every scored read with an indicator call (incl. the 95% one)
  });
});
