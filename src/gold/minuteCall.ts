// "Call at minute X": Jev reads the candle X minutes after it opens and calls its final color. Scored against the
// two simple alternatives at the same moment:
//   holds — whatever color the candle is at minute X, it stays that color
//   math  — the move so far against how far price typically travels in the time left
// The part that matters is when Jev DISAGREES with "holds" (calls a flip): that's the only place it can add
// anything beyond what the candle already shows.

export interface MinuteRead {
  time: number; //   candle open time
  pJev: number; //   Jev's chance the candle closes green, read at minute X
  pMath: number; //  the math's chance of green at the same moment
  move: number; //   close − open at minute X (its sign is the "holds" call)
}

export interface Score {
  right: number;
  n: number;
}

export interface MinuteScores {
  jev: Score;
  math: Score;
  holds: Score;
  /** Candles where Jev called the opposite of the current color: how often it was right. */
  jevFlips: Score;
  /** How often the candle actually changed color after minute X. */
  flipped: Score;
}

export const emptyScores = (): MinuteScores => ({
  jev: { right: 0, n: 0 },
  math: { right: 0, n: 0 },
  holds: { right: 0, n: 0 },
  jevFlips: { right: 0, n: 0 },
  flipped: { right: 0, n: 0 },
});

/** Add one finished candle (y = 1 green, 0 red; dojis are skipped). */
export function scoreRead(s: MinuteScores, r: MinuteRead, y: 0 | 1 | null) {
  if (y === null || r.move === 0) return;
  const hit = (p: number) => p > 0.5 === (y === 1);
  const add = (x: Score, ok: boolean) => {
    x.n += 1;
    if (ok) x.right += 1;
  };
  if (r.pJev !== 0.5) add(s.jev, hit(r.pJev));
  if (r.pMath !== 0.5) add(s.math, hit(r.pMath));
  const holdsGreen = r.move > 0;
  add(s.holds, holdsGreen === (y === 1));
  add(s.flipped, holdsGreen !== (y === 1));
  if (r.pJev !== 0.5 && r.pJev > 0.5 !== holdsGreen)
    add(s.jevFlips, hit(r.pJev));
}

/** Minutes offered per timeframe (0.5 = 30 seconds). */
export function minuteChoices(tfMin: number): number[] {
  return tfMin >= 15 ? [0.5, 1, 2, 3, 5, 8] : tfMin >= 5 ? [0.5, 1, 2, 3] : [];
}

/** "30 seconds" / "minute 2" — for labels. */
export function readLabel(m: number): string {
  return m < 1 ? `${Math.round(m * 60)} seconds` : `minute ${m}`;
}

/** Short button label: "30s", "1", "2" … */
export function readShort(m: number): string {
  return m < 1 ? `${Math.round(m * 60)}s` : String(m);
}
