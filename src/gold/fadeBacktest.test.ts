import { describe, expect, it } from "vitest";
import { backtest, emasAtReads, type Read } from "./fadeBacktest";
import * as bot from "../../supabase/functions/_shared/fadeStrategy";

describe("EMA-rule backtest", () => {
  it("bets with Jev, hold or flip, only when the EMAs agree — same as the bot", () => {
    // rising candles → fast EMA above slow
    const candles = Array.from({ length: 60 }, (_, i) => ({
      time: i * 300,
      close: 100 + i,
    }));
    const at = (
      k: number,
      pJev: number,
      move: number,
      y: 0 | 1 | null,
    ): Read => ({ time: k * 300, open: 100 + k - 1, move, pJev, y });
    const reads = [
      at(40, 0.7, 2, 1), //   hold up, fast > slow → bet up → win
      at(41, 0.3, -2, 1), //  hold down, fast > slow → skip
      at(42, 0.3, 2, 0), //   flip (green now, Jev red), fast > slow → skip
      at(43, 0.6, -1, 1), //  flip (red now, Jev green), fast > slow → bet up → win
      at(44, 0.5, 1, 1), //   no call
      at(45, 0.8, 0, 1), //   flat at the read
    ];
    const emas = emasAtReads(candles, reads);
    expect(emas.get(40 * 300)!.fast).toBeGreaterThan(emas.get(40 * 300)!.slow);
    const r = backtest(reads, emas);
    expect(r.bot).toEqual({ n: 2, wins: 2 });
    expect(r.flips).toEqual({ n: 1, wins: 1 });
    expect(r.flipsAll).toEqual({ n: 2, wins: 2 });
    expect(r.skippedFlips).toBe(1);
    expect(r.holdsEma).toEqual({ n: 1, wins: 1 });
    expect(r.holdsAll).toEqual({ n: 2, wins: 1 });
    expect(r.skippedHolds).toBe(1);
    // the bot's own rule gives the same bets
    for (const x of reads) {
      const e = emas.get(x.time)!;
      const d = bot.emaRuleDecision(x.pJev, x.move, e.fast, e.slow);
      const side = "skip" in d ? null : d.side;
      const exp =
        x.time === 40 * 300
          ? "up"
          : x.time === 42 * 300
            ? null
            : x.time === 43 * 300
              ? "up"
              : null;
      expect(side).toBe(exp);
    }
  });

  it("skips bets when the EMAs are too close together", () => {
    const candles = Array.from({ length: 60 }, (_, i) => ({
      time: i * 300,
      close: 100 + i,
    }));
    const reads: Read[] = [
      { time: 40 * 300, open: 139, move: 2, pJev: 0.7, y: 1 },
    ];
    const emas = emasAtReads(candles, reads);
    const e = emas.get(40 * 300)!;
    const gap = e.fast - e.slow; // a few dollars on this series
    expect(backtest(reads, emas, gap - 0.5).bot.n).toBe(1);
    expect(backtest(reads, emas, gap + 0.5).bot.n).toBe(0);
    expect(
      "skip" in bot.emaRuleDecision(0.7, 2, e.fast, e.slow, gap + 0.5),
    ).toBe(true);
    expect(
      bot.emaRuleDecision(0.7, 2, e.fast, e.slow, gap - 0.5),
    ).toMatchObject({ side: "up" });
    expect(bot.emaRuleDecision(0.3, -2, 100, 160, 60)).toMatchObject({
      side: "down",
    }); // exactly $60 apart
    expect("skip" in bot.emaRuleDecision(0.3, -2, 100, 159.9, 60)).toBe(true); // $59.90 apart
  });
});
