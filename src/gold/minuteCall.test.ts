import { describe, expect, it } from "vitest";
import { emptyScores, minuteChoices, regimeOf, scoreRead, scoreRegime, type JevHit } from "./minuteCall";

describe("Jev's call at minute X", () => {
  it("scores Jev against 'current color holds' and counts Jev's flip calls separately", () => {
    const s = emptyScores();
    scoreRead(s, { time: 1, pJev: 0.7, pMath: 0.8, move: +2 }, 1); // green, held: all right
    scoreRead(s, { time: 2, pJev: 0.3, pMath: 0.7, move: +1 }, 0); // green then flipped red: Jev called the flip
    scoreRead(s, { time: 3, pJev: 0.4, pMath: 0.6, move: +1 }, 1); // Jev called a flip, wrong
    expect(s.holds).toEqual({ right: 2, n: 3 });
    expect(s.jev).toEqual({ right: 2, n: 3 });
    expect(s.jevFlips).toEqual({ right: 1, n: 2 });
    expect(s.flipped).toEqual({ right: 1, n: 3 });
    expect(minuteChoices(15)).toContain(3);
    expect(minuteChoices(1)).toEqual([]);
  });

  it("tracks the regime from Jev's own record, without peeking at the candle being scored", () => {
    const s = emptyScores();
    const hits: JevHit[] = [];
    const TF = 300;
    // 8 candles where Jev says "holds green" and it reverses red (Jev wrong) …
    for (let i = 0; i < 8; i++) scoreRegime(s, hits, { time: i * TF, pJev: 0.7, pMath: 0.5, move: 1 }, 0, TF);
    expect(regimeOf(hits, 8 * TF, TF)).toEqual({ regime: "backwards", right: 0, n: 8 });
    // the first 6 were "unsure" (Jev as is, wrong; bot bets the hold, wrong), the next 2 backwards (flipped: right)
    expect(s.adjusted).toEqual({ right: 2, n: 8 });
    expect(s.bot).toEqual({ right: 2, n: 8 });
    expect(s.afterMiss).toEqual({ right: 0, n: 7 });
    // … then a backwards stretch with a flip call: the bot bets the hold
    const before = s.bot.n;
    scoreRegime(s, hits, { time: 8 * TF, pJev: 0.3, pMath: 0.5, move: 1 }, 1, TF);
    expect(s.bot).toEqual({ right: 3, n: before + 1 });
    // old reads (far in the past) don't count
    expect(regimeOf(hits, 1000 * TF, TF).n).toBe(0);
  });
});
