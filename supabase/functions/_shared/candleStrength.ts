// AUTO-COPIED from src/gold/candleStrength.ts — edit that file and copy it here (a test keeps them identical).
// Lightspeed candle strength: one signed score for how strongly the forming candle is going one way, built from
// the Lightspeed core (lightspeedCore) and, when available, the live market block (lightspeedLive).
// The bot's copy is supabase/functions/_shared/candleStrength.ts (kept identical by a test).
//
// Each part is scaled to −1 … +1 (+ = up), then weighted; parts that are missing are left out and the weights of
// the rest are rescaled. Score = −100 … +100; its sign is the direction, its size the strength.
//   momentum   35  the move so far against what's normal for the time elapsed (a z-score), tanh(z / 2)
//   close      20  where price sits in the candle's range so far: at the high = +1, at the low = −1
//   flow       15  aggressive buying vs selling on Coinbase in the last 30 s
//   book       15  order-book imbalance within 25 bps (Coinbase and Kraken averaged)
//   others     15  ETH/SOL (or BTC/ETH) move since the candle opened, tanh(% / 0.1)

type Obj = Record<string, unknown>;

const num = (o: unknown, ...path: string[]): number | null => {
  const v = path.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Obj)[k] : undefined), o);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const clamp = (x: number) => Math.max(-1, Math.min(1, x));

export const STRENGTH_WEIGHTS = { momentum: 35, close: 20, flow: 15, book: 15, others: 15 } as const;

export interface CandleStrength {
  score: number; //        −100 … +100 (+ = up)
  direction: "up" | "down" | "flat";
  strength: number; //     0 … 100
  parts: Partial<Record<keyof typeof STRENGTH_WEIGHTS, number>>; // each −1 … +1
  used: string; //         which parts were available, e.g. "momentum, close, flow"
}

/**
 * `core` = lightspeedCore(...) for the forming candle; `live` = lightspeedLive(...) (or null); `elapsed` seconds in.
 * `range` = the candle so far (open/high/low/close) for the close-location part.
 */
export function candleStrength(
  core: Obj | null,
  live: Obj | null,
  elapsed: number,
  tfSec: number,
  range: { open: number; high: number; low: number; close: number } | null,
): CandleStrength | null {
  const fp = core?.finish_probability;
  const move = num(fp, "move_dollars");
  const perCandlePct = num(core, "volatility", "per_candle_pct");
  if (move === null || perCandlePct === null || !range || !(elapsed > 0)) return null;
  const parts: CandleStrength["parts"] = {};

  // Momentum: the move against one candle's volatility scaled to the time elapsed.
  const sdSoFar = range.open * (perCandlePct / 100) * Math.sqrt(Math.min(1, elapsed / tfSec));
  if (sdSoFar > 0) parts.momentum = Math.tanh(move / sdSoFar / 2);

  // Close location in the range so far.
  const span = range.high - range.low;
  if (span > 0) parts.close = clamp(((range.close - range.low) / span) * 2 - 1);

  const buy30 = num(live, "coinbase_trade_flow_now", "last_30s", "buy_share_pct");
  const n30 = num(live, "coinbase_trade_flow_now", "last_30s", "trades");
  if (buy30 !== null && (n30 ?? 0) >= 5) parts.flow = clamp((buy30 - 50) / 50);

  const books = [num(live, "coinbase_order_book", "imbalance_within_25bps"), num(live, "kraken_order_book", "imbalance_within_25bps")]
    .filter((x): x is number => x !== null);
  if (books.length) parts.book = clamp(books.reduce((a, b) => a + b, 0) / books.length);

  const others = live?.other_coins as Obj | undefined;
  const moves = others
    ? Object.values(others).map((o) => num(o, "move_since_candle_open_pct")).filter((x): x is number => x !== null)
    : [];
  if (moves.length) parts.others = Math.tanh(moves.reduce((a, b) => a + b, 0) / moves.length / 0.1);

  let w = 0;
  let s = 0;
  for (const [k, v] of Object.entries(parts)) {
    const wk = STRENGTH_WEIGHTS[k as keyof typeof STRENGTH_WEIGHTS];
    w += wk;
    s += wk * (v as number);
  }
  if (!w) return null;
  const score = Number(((s / w) * 100).toFixed(1));
  for (const k of Object.keys(parts) as (keyof typeof parts)[]) parts[k] = Number((parts[k] as number).toFixed(3));
  return {
    score,
    direction: score > 0 ? "up" : score < 0 ? "down" : "flat",
    strength: Math.abs(score),
    parts,
    used: Object.keys(parts).join(", "),
  };
}
