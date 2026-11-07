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

  it("the $60 line switches from the trend rule to the close-EMAs rule", () => {
    expect(bot.emaRuleDecision(0.3, -2, 100, 160, 60)).toMatchObject({
      side: "down",
      kind: "hold-ema",
    }); // exactly $60
    expect("skip" in bot.emaRuleDecision(0.3, -2, 100, 159.9, 60, "down")).toBe(
      true,
    ); // $59.90: EMAs agree → none
    expect(bot.emaRuleDecision(0.3, -2, 159.9, 100, 60, "down")).toMatchObject({
      side: "up",
      kind: "hold-fade-chop",
    });
    expect(bot.emaRuleDecision(0.3, 2, 100, 159.9, 60, "up")).toMatchObject({
      side: "down",
      kind: "flip-with-chop",
    });
    expect(bot.emaRuleDecision(0.3, 2, 100, 160, 60, "down")).toMatchObject({
      side: "down",
      kind: "flip-ema",
    }); // $60: trend
  });

  it("takes flip bets only in the 'Jev right' regime when asked", () => {
    const candles = Array.from({ length: 60 }, (_, i) => ({
      time: i * 300,
      close: 100 + i,
    }));
    // flips up (candle red, Jev green) with fast > slow — the EMAs agree
    const reads: Read[] = [
      {
        time: 40 * 300,
        open: 139,
        move: -1,
        pJev: 0.6,
        y: 1,
        regime: "normal",
      },
      {
        time: 41 * 300,
        open: 140,
        move: -1,
        pJev: 0.6,
        y: 1,
        regime: "unsure",
      },
      {
        time: 42 * 300,
        open: 141,
        move: -1,
        pJev: 0.6,
        y: 1,
        regime: "backwards",
      },
      {
        time: 43 * 300,
        open: 142,
        move: 1,
        pJev: 0.6,
        y: 1,
        regime: "backwards",
      }, // a hold: not affected
    ];
    const emas = emasAtReads(candles, reads);
    expect(backtest(reads, emas).bot.n).toBe(4);
    const r = backtest(reads, emas, 0, true);
    expect(r.flips.n).toBe(1);
    expect(r.holdsEma.n).toBe(1);
    expect(r.skippedFlipsRegime).toBe(2);
  });

  it("EMAs close: holds = last candle + EMAs against → against Jev; flips with EMAs + last other color → with Jev", () => {
    // HOLD green after green, EMAs down (against Jev) → bet Down
    expect(bot.emaRuleDecision(0.7, 2, 100, 115, 60, "up")).toMatchObject({
      side: "down",
      kind: "hold-fade-chop",
    });
    // HOLD red after red, EMAs up (against Jev) → bet Up
    expect(bot.emaRuleDecision(0.3, -2, 115, 100, 60, "down")).toMatchObject({
      side: "up",
      kind: "hold-fade-chop",
    });
    // HOLD after the other color → no bet (your answer), whatever the EMAs
    expect("skip" in bot.emaRuleDecision(0.7, 2, 100, 115, 60, "down")).toBe(
      true,
    );
    expect(
      "skip" in bot.emaRuleDecision(0.62, 2, 75899.08, 75845.23, 60, "down"),
    ).toBe(true); // 17:44
    // HOLD after the same color but EMAs agree with Jev → no bet
    expect("skip" in bot.emaRuleDecision(0.7, 2, 115, 100, 60, "up")).toBe(
      true,
    );
    // FLIP red (candle green), EMAs down, last green → bet Down (your 19:08 example)
    expect(
      bot.emaRuleDecision(0.28, 2, 75818.8, 75830.83, 60, "up"),
    ).toMatchObject({
      side: "down",
      kind: "flip-with-chop",
    });
    // FLIP with the EMAs but last candle the same color as the call (17:47) → no bet
    expect(
      "skip" in bot.emaRuleDecision(0.62, -2, 75911.33, 75860.81, 60, "up"),
    ).toBe(true);
    // FLIP against the EMAs → no bet; level EMAs → no bet
    expect("skip" in bot.emaRuleDecision(0.7, -2, 100, 120, 60, "down")).toBe(
      true,
    );
    expect("skip" in bot.emaRuleDecision(0.7, 2, 100, 100, 60, "up")).toBe(
      true,
    );
    // far apart: the trend rule
    expect(bot.emaRuleDecision(0.7, 2, 200, 100, 60, "up")).toMatchObject({
      side: "up",
      kind: "hold-ema",
    });

    // falling candles → fast below slow (EMAs down)
    const down = Array.from({ length: 60 }, (_, i) => ({
      time: i * 300,
      close: 200 - i,
    }));
    const reads: Read[] = [
      { time: 40 * 300, open: 161, move: 2, pJev: 0.7, y: 0, last: 1 }, // hold green after green, EMAs down → bet red → win
      { time: 41 * 300, open: 160, move: 2, pJev: 0.7, y: 0, last: 0 }, // hold green after red → skip
      { time: 42 * 300, open: 159, move: -2, pJev: 0.3, y: 0, last: 0 }, // hold red after red, EMAs agree → skip
      { time: 43 * 300, open: 158, move: 2, pJev: 0.3, y: 1, last: 1 }, // flip red, last green → bet red → loss
      { time: 44 * 300, open: 157, move: 2, pJev: 0.3, y: 1, last: 0 }, // flip red, last red → skip
    ];
    const r = backtest(reads, emasAtReads(down, reads), 60);
    expect(r.chop).toEqual({ n: 1, wins: 1 });
    expect(r.chopFlips).toEqual({ n: 1, wins: 0 });
    expect(r.bot).toEqual({ n: 2, wins: 1 });
    expect(r.skippedHolds).toBe(2);
    expect(r.skippedFlips).toBe(1);
  });
});
