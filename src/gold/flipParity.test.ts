import { describe, expect, it } from "vitest";
import * as front from "./flip";
import * as shared from "../../supabase/functions/_shared/flipState";
import * as bot from "../../supabase/functions/_shared/fadeStrategy";
import { fib, holdDecision, nextStep, winner } from "../../supabase/functions/_shared/fadeStrategy";
import * as page from "./minuteCall";

describe("edge-function copy of the candle reader", () => {
  it("gives Jev exactly the same snapshot as the page", () => {
    const candles = Array.from({ length: 120 }, (_, i) => {
      const o = 4000 + Math.sin(i / 7) * 10;
      const c = o + Math.cos(i / 3) * 3;
      return { time: i * 900, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c };
    });
    expect([...shared.atrByTime(candles)]).toEqual([...front.atrByTime(candles)]);
    expect(shared.bodySd(candles)).toEqual(front.bodySd(candles));
    const x = { forming: { time: 120 * 900, open: 4000, high: 4004, low: 3999, close: 4003 }, secondsLeft: 840, tfSeconds: 900, atr: 4, sd: 3, previous: candles.slice(-3) };
    expect(shared.flipState(x)).toEqual(front.flipState(x));
    expect(shared.greenFromFlip(2, 0.3)).toEqual(front.greenFromFlip(2, 0.3));
  });

  it("bets only Jev's hold calls, on the current color", () => {
    expect(holdDecision(0.7, +5)).toEqual({ side: "up", sure: 0.7 });
    expect(holdDecision(0.3, -5)).toEqual({ side: "down", sure: 0.7 });
    expect(holdDecision(0.51, +1)).toEqual({ side: "up", sure: 0.51 });
    expect(holdDecision(0.4, +5)).toBeNull(); // Jev calls a flip
    expect(holdDecision(0.7, 0)).toBeNull();
    expect([0, 1, 2, 3, 4, 5].map(fib)).toEqual([1, 1, 2, 3, 5, 8]);
    expect(nextStep(5, true, null)).toBe(3);
    expect(winner(1, 1)).toBe("up");
  });

  it("works out the same regime, and the same bet, as the page", () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({ time: i * 300, hit: (i * 7) % 5 < 2 }));
    for (const now of [0, 1500, 3000, 6000, 9000, 20000]) {
      const a = bot.regimeOf(hits, now, 300);
      expect(page.regimeOf(hits, now, 300)).toEqual(a);
      for (const [p, mv] of [[0.7, 5], [0.3, 5], [0.7, -5], [0.3, -5], [0.5, 1], [0.7, 0]] as const) {
        const d = bot.regimeDecision(p, mv, a.regime);
        expect(page.botSide(p, mv, a)).toEqual(d ? d.side : null);
      }
    }
    expect(bot.regimeDecision(0.7, 5, "backwards")).toEqual({ side: "down", sure: 0.7, kind: "fade-hold" });
    expect(bot.regimeDecision(0.3, 5, "backwards")).toEqual({ side: "up", sure: 0.7, kind: "fade-flip" });
    expect(bot.regimeDecision(0.3, 5, "normal")).toBeNull();
    expect(bot.regimeDecision(0.3, -5, "unsure")).toEqual({ side: "down", sure: 0.7, kind: "hold" });
  });

  it("3-minute fade: bets against Jev only when it's 51–70% sure", () => {
    // default range 70–90%, both ends included
    expect(bot.fadeCallDecision(0.8, 5)).toEqual({ side: "down", sure: 0.8, kind: "fade-hold" });
    expect(bot.fadeCallDecision(0.25, 5)).toEqual({ side: "up", sure: 0.75, kind: "fade-flip" });
    expect(bot.fadeCallDecision(0.3, 5)?.side).toBe("up"); // exactly 70%
    expect(bot.fadeCallDecision(0.9, 5)?.side).toBe("down"); // exactly 90%
    expect(bot.fadeCallDecision(0.69, 5)).toBeNull();
    expect(bot.fadeCallDecision(0.91, 5)).toBeNull();
    expect(bot.fadeCallDecision(0.5, 5)).toBeNull();
    expect(bot.fadeCallDecision(0.6, -5, 0.7, 0.5)).toEqual({ side: "down", sure: 0.6, kind: "fade-flip" });
  });
});
