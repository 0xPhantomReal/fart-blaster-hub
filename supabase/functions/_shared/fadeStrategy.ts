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
export function nextStep(step: number, won: boolean, maxStep: number | null): number {
  const s = won ? Math.max(0, step - 2) : step + 1;
  return maxStep === null ? s : Math.min(s, maxStep);
}

/** `move` = price now − price to beat. `pGreen` = Jev's chance it closes Up. */
export function holdDecision(pGreen: number, move: number): { side: Side; sure: number } | null {
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
export function regimeOf(hits: JevHit[], now: number, tfSec: number, n = REGIME_N): { regime: Regime; right: number; n: number } {
  const recent = hits.filter((h) => h.time < now && h.time >= now - 3 * n * tfSec).slice(-n);
  const right = recent.filter((h) => h.hit).length;
  const k = recent.length;
  const regime: Regime = k < REGIME_MIN || right * 2 === k ? "unsure" : right * 2 > k ? "normal" : "backwards";
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
): { side: Side; sure: number; kind: "hold" | "fade-hold" | "fade-flip" } | null {
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
 * The 3-minute fade: when Jev's call is only mildly sure (over 50%, up to `max`), bet the OTHER side.
 * Jev's call can be a hold or a flip; either way the bet goes against it. Above `max` → no bet.
 */
export function fadeCallDecision(
  pGreen: number,
  move: number,
  max = 0.7,
): { side: Side; sure: number; kind: "fade-hold" | "fade-flip" } | null {
  if (pGreen === 0.5) return null;
  const sure = Math.max(pGreen, 1 - pGreen);
  if (sure > max + 1e-9) return null;
  const jev: Side = pGreen > 0.5 ? "up" : "down";
  const current: Side | null = move > 0 ? "up" : move < 0 ? "down" : null;
  return { side: jev === "up" ? "down" : "up", sure, kind: current === null || jev === current ? "fade-hold" : "fade-flip" };
}

/** Up wins when the closing reference is >= the opening one. */
export function winner(openRef: number, closeRef: number): Side {
  return closeRef >= openRef ? "up" : "down";
}

/** Profit of `shares` bought at `price` each (0–1): $1 a share if it wins. */
export function pnl(shares: number, price: number, won: boolean): number {
  return won ? shares * (1 - price) : -shares * price;
}
