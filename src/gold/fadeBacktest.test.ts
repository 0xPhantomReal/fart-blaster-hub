import { describe, expect, it } from "vitest";
import { backtest, emasAtReads, type Read } from "./fadeBacktest";
import * as bot from "../../supabase/functions/_shared/fadeStrategy";

describe("EMA-rule backtest", () => {
  it("bets flips with Jev, and holds only with the EMAs — same as the bot", () => {
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
      at(42, 0.3, 2, 0), //   flip (green now, Jev red) → bet down (with Jev) → win
      at(43, 0.6, -1, 1), //  flip (red now, Jev green) → bet up (with Jev) → win
      at(44, 0.5, 1, 1), //   no call
      at(45, 0.8, 0, 1), //   flat at the read
    ];
    const emas = emasAtReads(candles, reads);
    expect(emas.get(40 * 300)!.fast).toBeGreaterThan(emas.get(40 * 300)!.slow);
    const r = backtest(reads, emas);
    expect(r.bot).toEqual({ n: 3, wins: 3 });
    expect(r.flips).toEqual({ n: 2, wins: 2 });
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
            ? "down"
            : x.time === 43 * 300
              ? "up"
              : null;
      expect(side).toBe(exp);
    }
  });
});
