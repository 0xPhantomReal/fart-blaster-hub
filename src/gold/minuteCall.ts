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
  /** Regime-adjusted chance of green: Jev's read as is, or flipped when Jev has been backwards lately. */
  pAdj?: number;
  regime?: RegimeInfo;
}

// ── Regimes (keep in step with supabase/functions/_shared/fadeStrategy.ts; see flipParity.test.ts) ──
export const REGIME_N = 12;
export const REGIME_MIN = 6;
export type Regime = "normal" | "backwards" | "unsure";
export interface RegimeInfo {
  regime: Regime;
  right: number;
  n: number;
}
export interface JevHit {
  time: number;
  hit: boolean;
}

/** The regime before the candle opening at `now`: Jev's hits among the last `n` reads (only recent ones count). */
export function regimeOf(
  hits: JevHit[],
  now: number,
  tfSec: number,
  n = REGIME_N,
): RegimeInfo {
  const recent = hits
    .filter((h) => h.time < now && h.time >= now - 3 * n * tfSec)
    .slice(-n);
  const right = recent.filter((h) => h.hit).length;
  const k = recent.length;
  const regime: Regime =
    k < REGIME_MIN || right * 2 === k
      ? "unsure"
      : right * 2 > k
        ? "normal"
        : "backwards";
  return { regime, right, n: k };
}

/** Jev's read adjusted for the regime: flipped when Jev has been backwards. */
export const adjustForRegime = (pJev: number, r: RegimeInfo) =>
  r.regime === "backwards" ? 1 - pJev : pJev;

/** What the bot would bet: "up"/"down", or null for no bet (normal/unsure: hold calls only; backwards: against Jev). */
export function botSide(
  pJev: number,
  move: number,
  r: RegimeInfo,
): "up" | "down" | null {
  if (move === 0 || pJev === 0.5) return null;
  const jevUp = pJev > 0.5;
  if (r.regime === "backwards") return jevUp ? "down" : "up";
  return jevUp === move > 0 ? (jevUp ? "up" : "down") : null;
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
  /** Regime-adjusted call (Jev as is, or flipped while Jev has been backwards). */
  adjusted: Score;
  /** The bot's rule: hold calls in a normal regime, against Jev in a backwards one. */
  bot: Score;
  /** Persistence: how often Jev was right right after a hit, and right after a miss. */
  afterHit: Score;
  afterMiss: Score;
}

export const emptyScores = (): MinuteScores => ({
  jev: { right: 0, n: 0 },
  math: { right: 0, n: 0 },
  holds: { right: 0, n: 0 },
  jevFlips: { right: 0, n: 0 },
  flipped: { right: 0, n: 0 },
  adjusted: { right: 0, n: 0 },
  bot: { right: 0, n: 0 },
  afterHit: { right: 0, n: 0 },
  afterMiss: { right: 0, n: 0 },
});

/**
 * Score one finished candle's regime parts and add Jev's hit to `hits` (call in time order, after scoreRead).
 * The regime is worked out from the hits BEFORE this candle, so nothing peeks at the result.
 */
export function scoreRegime(
  s: MinuteScores,
  hits: JevHit[],
  r: MinuteRead,
  y: 0 | 1 | null,
  tfSec: number,
) {
  if (y === null || r.move === 0 || r.pJev === 0.5) return;
  const add = (x: Score, ok: boolean) => {
    x.n += 1;
    if (ok) x.right += 1;
  };
  const reg = r.regime ?? regimeOf(hits, r.time, tfSec);
  const pAdj = adjustForRegime(r.pJev, reg);
  if (pAdj !== 0.5) add(s.adjusted, pAdj > 0.5 === (y === 1));
  const side = botSide(r.pJev, r.move, reg);
  if (side) add(s.bot, (side === "up") === (y === 1));
  const hit = r.pJev > 0.5 === (y === 1);
  const prev = hits[hits.length - 1];
  if (prev && r.time - prev.time <= tfSec * 1.5)
    add(prev.hit ? s.afterHit : s.afterMiss, hit); // only back-to-back candles
  hits.push({ time: r.time, hit });
}

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
  // 3, 5 and 15 seconds are written as seconds/60 so they match the bot's request key exactly.
  const early = [3 / 60, 5 / 60, 15 / 60];
  return tfMin >= 15
    ? [...early, 0.5, 1, 2, 3, 5, 8]
    : tfMin >= 5
      ? [...early, 0.5, 1, 2, 3]
      : [];
}

/** "30 seconds" / "minute 2" — for labels. */
export function readLabel(m: number): string {
  return m < 1 ? `${Math.round(m * 60)} seconds` : `minute ${m}`;
}

/** Short button label: "30s", "1", "2" … */
export function readShort(m: number): string {
  return m < 1 ? `${Math.round(m * 60)}s` : String(m);
}
