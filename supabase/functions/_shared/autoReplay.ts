// Auto-mode replay: for past windows, what the bot's auto mode WOULD have chosen at the moment Jev's call triggered,
// next to what the bot actually traded. Uses the same trend check the live bot uses (fadeStrategy.trendSummary), with
// the price at the call taken from 1-minute candles, and the 5-minute EMAs moved live to that price.
import { trendSummary } from "./fadeStrategy.ts";
import { emaSeries, TV_INPUTS } from "./tvIndicator.ts";

type C = { time: number; open: number; high: number; low: number; close: number };
type Side = "up" | "down";

export interface ReplayCall {
  window: number; //  window start (unix s)
  atSec: number; //   seconds into the window when the call triggered
  pUp: number; //     Jev's chance of green then
}
export interface ReplayTrade {
  window: number;
  side: Side; //      side actually bought (or watched, if nothing was bought)
  status: string; //  open | settled | sold | watching | void
  result: string | null; // win | loss | not triggered | …
  pnl: number | null;
}

export interface ReplayRow {
  window: number;
  atSec: number;
  jevPick: Side;
  jevPct: number;
  label: string;
  down: number; //    trend checks pointing down (0–5)
  up: number;
  auto: "straight" | "flip";
  autoWatch: Side; // the side auto mode would have watched (and bought at 60¢)
  actual: { side: Side; result: string | null; pnl: number | null } | null;
  sameSide: boolean | null; // did the actual trade's side match auto mode's side?
}

/** Price at a moment: the close of the 1-minute candle that ended at or before it (else that minute's open). */
function priceAt(c1: C[], t: number): number | null {
  let lo = 0;
  let hi = c1.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c1[mid].time <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  const c = c1[best];
  return t >= c.time + 60 ? c.close : c.open;
}

export function autoReplay(c5: C[], c1: C[], calls: ReplayCall[], trades: ReplayTrade[], tfSec = 300) {
  const closes = c5.map((c) => c.close);
  const fast = emaSeries(closes, TV_INPUTS.emaFastLen);
  const slow = emaSeries(closes, TV_INPUTS.emaSlowLen);
  const aF = 2 / (TV_INPUTS.emaFastLen + 1);
  const aS = 2 / (TV_INPUTS.emaSlowLen + 1);
  const idx = new Map(c5.map((c, i) => [c.time, i]));
  const tradeBy = new Map<number, ReplayTrade>();
  for (const t of trades) if (!tradeBy.has(t.window) || t.status !== "watching") tradeBy.set(t.window, t);

  const rows: ReplayRow[] = [];
  for (const call of calls) {
    const i = idx.get(call.window); // the window's own 5m candle
    if (i === undefined || i < 25) continue;
    const price = priceAt(c1, call.window + call.atSec) ?? c5[i].open;
    const pf = fast[i - 1];
    const ps = slow[i - 1];
    const emaF = pf === null ? null : aF * price + (1 - aF) * pf;
    const emaS = ps === null ? null : aS * price + (1 - aS) * ps;
    const w = c5.slice(Math.max(0, i - 14), i);
    const tr = w.map((c, j) =>
      j === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - w[j - 1].close), Math.abs(c.low - w[j - 1].close)),
    );
    const atr = tr.length ? tr.reduce((s, x) => s + x, 0) / tr.length : null;
    const closed = c5.slice(Math.max(0, i - 12), i);
    const t = trendSummary(closed, price, emaF, emaS, atr);
    const down = t.down_checks;
    const up = t.up_checks;
    const jevPick: Side = call.pUp >= 0.5 ? "up" : "down";
    const strong = /^strong (down|up)trend$/.test(t.label);
    const autoWatch: Side = strong ? jevPick : jevPick === "up" ? "down" : "up";
    const tr0 = tradeBy.get(call.window) ?? null;
    const actual = tr0 ? { side: tr0.side, result: tr0.result ?? tr0.status, pnl: tr0.pnl } : null;
    rows.push({
      window: call.window,
      atSec: Math.round(call.atSec),
      jevPick,
      jevPct: Math.round(Math.max(call.pUp, 1 - call.pUp) * 100),
      label: t.label,
      down,
      up,
      auto: strong ? "straight" : "flip",
      autoWatch,
      actual,
      sameSide: actual ? actual.side === autoWatch : null,
    });
  }

  // Cross-reference: the bot's real trades, split by whether auto mode would have been on the same side.
  const settled = rows.filter((r) => r.actual && (r.actual.result === "win" || r.actual.result === "loss"));
  const group = (xs: ReplayRow[]) => ({
    trades: xs.length,
    wins: xs.filter((r) => r.actual!.result === "win").length,
    losses: xs.filter((r) => r.actual!.result === "loss").length,
    pnl: Number(xs.reduce((s, r) => s + (r.actual!.pnl ?? 0), 0).toFixed(2)),
  });
  return {
    rows,
    summary: {
      calls: rows.length,
      auto_straight: rows.filter((r) => r.auto === "straight").length,
      auto_flip: rows.filter((r) => r.auto === "flip").length,
      // Real trades where auto mode would have bought the same side / the other side.
      trades_auto_same_side: group(settled.filter((r) => r.sameSide)),
      trades_auto_other_side: group(settled.filter((r) => r.sameSide === false)),
    },
  };
}
