// Polymarket bot decisions (used by the fadebot edge function; tested in src/gold/flipParity.test.ts).
//
// Hold-only rule: Jev reads the candle 30 seconds in. If Jev says the candle HOLDS its current color (more than
// 50% sure of that color), bet that color. If Jev calls a flip, or the candle is exactly at the price to beat,
// don't bet.

export type Side = "up" | "down";

export function fib(step: number): number {
  let a = 1;
  let b = 1;
  for (let i = 0; i < step; i++) [a, b] = [b, a + b];
  return a;
}

/** One step up the Fibonacci sequence after a loss, two back after a win. */
export function nextStep(
  step: number,
  won: boolean,
  maxStep: number | null,
): number {
  const s = won ? Math.max(0, step - 2) : step + 1;
  return maxStep === null ? s : Math.min(s, maxStep);
}

/** `move` = price now − price to beat. `pGreen` = Jev's chance it closes Up. */
export function holdDecision(
  pGreen: number,
  move: number,
): { side: Side; sure: number } | null {
  if (move === 0 || pGreen === 0.5) return null;
  const current: Side = move > 0 ? "up" : "down";
  const jev: Side = pGreen > 0.5 ? "up" : "down";
  if (jev !== current) return null; // Jev calls a flip: ignored
  return { side: current, sure: Math.max(pGreen, 1 - pGreen) };
}

// ── Regimes ──
// Jev's 30-second read seems to run in stretches: some where it's mostly right (its holds hold) and some where it's
// mostly wrong (its flip calls go the other way and its holds reverse more). Jev's own record over the last
// REGIME_N candles says which stretch we're in. Keep in step with src/gold/minuteCall.ts (parity test).

export const REGIME_N = 12; //    candles looked back on
export const REGIME_MIN = 6; //   fewer scored reads than this → "unsure"
export type Regime = "normal" | "backwards" | "unsure";
export interface JevHit {
  time: number; // candle open time
  hit: boolean; // Jev's read called the final color right
}

/** The regime before the candle opening at `now`: Jev's hits among the last `n` reads (only recent ones count). */
export function regimeOf(
  hits: JevHit[],
  now: number,
  tfSec: number,
  n = REGIME_N,
): { regime: Regime; right: number; n: number } {
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

/**
 * The bot's bet with regimes:
 *   normal / unsure → hold calls only (Jev says the current color holds → bet it; flip calls ignored)
 *   backwards       → bet against Jev: its hold call → bet the reversal; its flip call → bet the hold
 */
export function regimeDecision(
  pGreen: number,
  move: number,
  regime: Regime,
): {
  side: Side;
  sure: number;
  kind: "hold" | "fade-hold" | "fade-flip";
} | null {
  if (move === 0 || pGreen === 0.5) return null;
  const current: Side = move > 0 ? "up" : "down";
  const jev: Side = pGreen > 0.5 ? "up" : "down";
  const sure = Math.max(pGreen, 1 - pGreen);
  if (regime === "backwards") {
    const side: Side = jev === "up" ? "down" : "up";
    return { side, sure, kind: jev === current ? "fade-hold" : "fade-flip" };
  }
  if (jev !== current) return null;
  return { side: current, sure, kind: "hold" };
}

/**
 * The fade: when Jev's call is between `min` and `max` sure (both included), bet the OTHER side.
 * Jev's call can be a hold or a flip; either way the bet goes against it. Outside the range (or 50%) → no bet.
 */
export function fadeCallDecision(
  pGreen: number,
  move: number,
  max = 0.9,
  min = 0.5,
): { side: Side; sure: number; kind: "fade-hold" | "fade-flip" } | null {
  if (pGreen === 0.5) return null;
  const sure = Math.max(pGreen, 1 - pGreen);
  if (sure > max + 1e-9 || sure < min - 1e-9) return null;
  const jev: Side = pGreen > 0.5 ? "up" : "down";
  const current: Side | null = move > 0 ? "up" : move < 0 ? "down" : null;
  return {
    side: jev === "up" ? "down" : "up",
    sure,
    kind: current === null || jev === current ? "fade-hold" : "fade-flip",
  };
}

/**
 * The EMA rule (Jev's read + the chart's fast/slow EMAs).
 * EMAs at least `minGap` apart (a trend):
 *   bet WITH Jev's call (hold or flip) when the EMAs agree: up with fast > slow, down with fast < slow; else no bet
 * EMAs closer than `minGap` (no clear trend):
 *   a HOLD call the same color as the last closed candle, with the EMAs pointing against Jev → bet AGAINST Jev
 *   a FLIP call with the EMAs pointing Jev's way and the last candle the other color from the call → bet WITH Jev
 *   anything else → no bet
 * Always no bet on a 50% read or a candle exactly at its open.
 */
export function emaRuleDecision(
  pGreen: number,
  move: number,
  emaFast: number | null,
  emaSlow: number | null,
  minGap = 0, // the trend needs the EMAs at least this far apart (in dollars)
  lastColor: Side | null = null, // the last closed candle: up = green, down = red, null = flat/unknown
):
  | {
      side: Side;
      sure: number;
      kind: "flip-ema" | "hold-ema" | "hold-fade-chop" | "flip-with-chop";
    }
  | { skip: string } {
  if (pGreen === 0.5) return { skip: "no call (50%)" };
  if (move === 0)
    return { skip: "candle exactly at its open, so neither a hold nor a flip" };
  const sure = Math.max(pGreen, 1 - pGreen);
  const jev: Side = pGreen > 0.5 ? "up" : "down";
  const kind = jev === (move > 0 ? "up" : "down") ? "hold-ema" : "flip-ema";
  const call = kind === "hold-ema" ? "hold" : "flip";
  const color = (x: Side | null) =>
    x === "up" ? "green" : x === "down" ? "red" : "flat";
  if (emaFast === null || emaSlow === null)
    return { skip: "EMAs not available" };
  const gap = Math.abs(emaFast - emaSlow);
  if (gap < minGap - 1e-9) {
    const close = `EMAs only $${gap.toFixed(2)} apart (under $${minGap})`;
    const emaSide: Side | null =
      emaFast > emaSlow ? "up" : emaFast < emaSlow ? "down" : null;
    const opp: Side = jev === "up" ? "down" : "up";
    const emas = emaSide === null ? "are level" : `point ${emaSide}`;
    if (kind === "hold-ema") {
      // HOLD: the last candle is Jev's color AND the EMAs point against Jev → bet AGAINST Jev (the EMAs' side).
      if (lastColor !== jev)
        return {
          skip: `hold ${color(jev)} with ${close}, but the last candle was ${color(lastColor)} (needs ${color(jev)})`,
        };
      if (emaSide !== opp)
        return {
          skip: `hold ${color(jev)} with ${close}, but the EMAs ${emas} (need ${opp})`,
        };
      return { side: opp, sure, kind: "hold-fade-chop" };
    }
    // FLIP: the EMAs point Jev's way AND the last candle is the other color from Jev's call → bet WITH Jev.
    if (emaSide !== jev)
      return {
        skip: `flip ${color(jev)} with ${close}, but the EMAs ${emas} (need ${jev})`,
      };
    if (lastColor !== opp)
      return {
        skip: `flip ${color(jev)} with ${close}, but the last candle was ${color(lastColor)} (needs ${color(opp)})`,
      };
    return { side: jev, sure, kind: "flip-with-chop" };
  }

  if (
    (jev === "up" && emaFast > emaSlow) ||
    (jev === "down" && emaFast < emaSlow)
  )
    return { side: jev, sure, kind };
  return {
    skip: `${call} ${jev} but fast EMA is ${emaFast > emaSlow ? "above" : emaFast < emaSlow ? "below" : "equal to"} slow`,
  };
}

/** Up wins when the closing reference is >= the opening one. */
export function winner(openRef: number, closeRef: number): Side {
  return closeRef >= openRef ? "up" : "down";
}

/** Profit of `shares` bought at `price` each (0–1): $1 a share if it wins. */
export function pnl(shares: number, price: number, won: boolean): number {
  return won ? shares * (1 - price) : -shares * price;
}

/**
 * The Lightspeed fade: in the first `windowSec` seconds of the candle, when the move so far is bigger than
 * Lightspeed's typical move in the time left, bet the opposite side (move up → Down, move down → Up).
 * `ls` is lightspeedCore(...) for the forming candle.
 */
export function lightspeedFadeDecision(
  ls: Record<string, unknown> | null,
  elapsed: number,
  windowSec = 120,
): { side: Side; move: number; typical: number } | { skip: string } {
  if (elapsed >= windowSec) return { skip: `past ${windowSec} s` };
  const fp = ls?.finish_probability as { move_dollars?: number; typical_move_in_time_left_dollars?: number } | undefined;
  const move = fp?.move_dollars;
  const typical = fp?.typical_move_in_time_left_dollars;
  if (typeof move !== "number" || typeof typical !== "number" || !(typical > 0)) return { skip: "no Lightspeed numbers" };
  if (Math.abs(move) <= typical) return { skip: "move within the typical move" };
  return { side: move > 0 ? "down" : "up", move, typical };
}

/** Take-profit price for a buy at `price` (our side's price): `mult` × price, or null when that can't happen (≥ $1). */
export function takeProfitPrice(price: number, mult = 2): number | null {
  const t = Number((price * mult).toFixed(4));
  return price > 0 && t < 1 ? t : null;
}

export interface LsRule {
  fadeWindowSec: number; //   fade only before this (default 120)
  strongFromSec: number; //   strength buys from … (default 60)
  strongToSec: number; //     … until (default 240)
  strongMin: number; //       strength needed, 0–100 (default 60)
}

/**
 * Lightspeed rule with candle strength ("strength decides"):
 *  - big move (bigger than the typical move) in the fade window: strong the same way → bet WITH it (once the strength
 *    window has opened; before that, wait); weak → fade it (bet against).
 *  - otherwise, inside the strength window: strong the same way as the move → bet WITH it.
 */
export function lightspeedDecision(
  ls: Record<string, unknown> | null,
  strength: { score: number; strength: number; direction: string } | null,
  elapsed: number,
  rule: LsRule,
): { side: Side; kind: "ls-fade" | "ls-strong"; move: number; typical: number } | { skip: string; wait?: boolean } {
  const fp = ls?.finish_probability as { move_dollars?: number; typical_move_in_time_left_dollars?: number } | undefined;
  const move = fp?.move_dollars;
  const typical = fp?.typical_move_in_time_left_dollars;
  if (typeof move !== "number" || typeof typical !== "number" || !(typical > 0)) return { skip: "no Lightspeed numbers" };
  if (move === 0) return { skip: "no move" };
  const moveSide: Side = move > 0 ? "up" : "down";
  const strong = !!strength && strength.direction === moveSide && strength.strength >= rule.strongMin;
  const inStrong = elapsed >= rule.strongFromSec && elapsed < rule.strongToSec;
  const big = Math.abs(move) > typical;
  if (big && elapsed < rule.fadeWindowSec) {
    if (!strong) return { side: moveSide === "up" ? "down" : "up", kind: "ls-fade", move, typical };
    if (inStrong) return { side: moveSide, kind: "ls-strong", move, typical };
    return { skip: "big and strong: waiting for the strength window", wait: true };
  }
  if (strong && inStrong) return { side: moveSide, kind: "ls-strong", move, typical };
  return { skip: elapsed >= Math.max(rule.fadeWindowSec, rule.strongToSec) ? "past the watch" : "nothing yet" };
}
