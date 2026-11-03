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

/** Up wins when the closing reference is >= the opening one. */
export function winner(openRef: number, closeRef: number): Side {
  return closeRef >= openRef ? "up" : "down";
}

/** Profit of `shares` bought at `price` each (0–1): $1 a share if it wins. */
export function pnl(shares: number, price: number, won: boolean): number {
  return won ? shares * (1 - price) : -shares * price;
}
