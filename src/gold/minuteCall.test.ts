import { describe, expect, it } from "vitest";
import { emptyScores, minuteChoices, scoreRead } from "./minuteCall";

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
});
