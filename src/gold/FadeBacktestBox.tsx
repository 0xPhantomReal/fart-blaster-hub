import { useMemo } from "react";
import {
  backtest,
  emasAtReads,
  type Bet,
  type Cat,
  type Read,
  type Tally,
} from "./fadeBacktest";
import type { ClosedBar } from "./useGold";

const MUTED = "text-[#8b949e]";
const GREEN = "text-[#26a69a]";
const RED = "text-[#ef5350]";

/**
 * How the bot's EMA rule would have done on this chart's past candles, from the page's own "Jev at …" reads.
 */
export function FadeBacktestBox({
  bars,
  readSec,
  readLabel,
  pastIsLive,
  botReadSec,
  limitPrice,
  limitShares,
  emaTf,
  emaGap,
  flipNeedsRegime,
  pmPoints,
}: {
  bars: ClosedBar[];
  readSec: number | null; // the "Jev at …" read the chart is showing (null = not a minute read)
  readLabel: string;
  pastIsLive: boolean; //   30s: the record is this browser's own reads, not a replay
  botReadSec: number;
  limitPrice: number;
  limitShares: number;
  emaTf: number;
  emaGap: number;
  flipNeedsRegime: boolean;
  pmPoints?: {
    window_start: number | string;
    pts: [number, number | null, number | null][];
  }[];
}) {
  const reads = useMemo((): Read[] => {
    const colorAt = new Map(
      bars.map((b) => [
        b.candle.time,
        b.candle.close > b.candle.open
          ? (1 as const)
          : b.candle.close < b.candle.open
            ? (0 as const)
            : null,
      ]),
    );
    const tf =
      bars.length > 1
        ? bars[bars.length - 1].candle.time - bars[bars.length - 2].candle.time
        : 300;
    return bars
      .filter((b) => b.pMin !== undefined && b.minMove !== undefined)
      .map((b) => ({
        time: b.candle.time,
        open: b.candle.open,
        move: b.minMove!,
        pJev: b.pMin!,
        regime: b.minRegime,
        last: colorAt.get(b.candle.time - tf) ?? null,
        y:
          b.candle.close > b.candle.open
            ? 1
            : b.candle.close < b.candle.open
              ? 0
              : null,
      }));
  }, [bars]);
  const r = useMemo(() => {
    if (readSec === null || !reads.length) return null;
    return backtest(
      reads,
      emasAtReads(
        bars.map((b) => b.candle),
        reads,
      ),
      emaGap,
      flipNeedsRegime,
    );
  }, [bars, reads, readSec, emaGap, flipNeedsRegime]);
  // Would the limit order have filled? Polymarket's price history (the cost to buy each side, about one point a
  // minute) after the read: filled if that side cost the limit price or less at any point before the window ended.
  const tfSec =
    bars.length > 1
      ? bars[bars.length - 1].candle.time - bars[bars.length - 2].candle.time
      : 300;
  const ptsBy = useMemo(
    () => new Map((pmPoints ?? []).map((w) => [Number(w.window_start), w.pts])),
    [pmPoints],
  );
  const lowAfterRead = (b: Bet): number | null => {
    const pts = ptsBy.get(b.time);
    if (!pts || readSec === null) return null;
    const after = pts
      .filter(([t]) => t >= readSec && t < tfSec)
      .map(([, up, down]) => (b.up ? up : down))
      .filter((x): x is number => typeof x === "number");
    return after.length ? Math.min(...after) : null;
  };
  const fills = (cat: Cat | "bot") => {
    const bets = (r?.bets ?? []).filter((b) => b.cats.includes(cat));
    let checked = 0;
    let filled = 0;
    let wins = 0;
    for (const b of bets) {
      const low = lowAfterRead(b);
      if (low === null) continue;
      checked += 1;
      if (low <= limitPrice + 1e-9) {
        filled += 1;
        if (b.win) wins += 1;
      }
    }
    return { checked, filled, wins };
  };
  const fmtRead = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);
  // P&L per filled order: a win pays (1 − price) a share, a loss costs the price.
  const pnl = (x: Tally) =>
    (x.wins * (1 - limitPrice) - (x.n - x.wins) * limitPrice) * limitShares;
  const row = (label: string, x: Tally, cat: Cat | "bot", strong = false) => {
    const p = x.n ? x.wins / x.n : null;
    const v = pnl(x);
    const f = fills(cat);
    const fv = pnl({ n: f.filled, wins: f.wins });
    return (
      <tr>
        <td className="py-0.5">{label}</td>
        <td
          className={`py-0.5 text-right ${strong ? "font-bold" : ""} ${p === null ? MUTED : p > limitPrice ? GREEN : RED}`}
        >
          {p === null ? "—" : `${(p * 100).toFixed(1)}%`}
        </td>
        <td className={`py-0.5 text-right ${MUTED}`}>{x.n}</td>
        <td
          className={`py-0.5 text-right ${x.n === 0 ? MUTED : v >= 0 ? GREEN : RED}`}
        >
          {x.n ? `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}` : "—"}
        </td>
        <td
          className={`py-0.5 text-right ${MUTED}`}
          title={
            f.checked
              ? `${f.filled} of ${f.checked} bets with Polymarket prices got down to ${Math.round(limitPrice * 100)}¢`
              : "no Polymarket prices for these candles"
          }
        >
          {f.checked ? `${f.filled}/${f.checked}` : "—"}
        </td>
        <td
          className={`py-0.5 text-right ${f.filled === 0 ? MUTED : f.wins / f.filled > limitPrice ? GREEN : RED}`}
        >
          {f.filled ? `${((f.wins / f.filled) * 100).toFixed(1)}%` : "—"}
        </td>
        <td
          className={`py-0.5 text-right ${f.filled === 0 ? MUTED : fv >= 0 ? GREEN : RED}`}
        >
          {f.checked
            ? `${fv >= 0 ? "+" : "−"}$${Math.abs(fv).toFixed(2)}`
            : "—"}
        </td>
      </tr>
    );
  };
  return (
    <div className="mt-3 rounded-md border border-[#262c36] p-2 text-xs">
      <div className="mb-1 font-semibold">Backtest of the bot's rule</div>
      {readSec === null ? (
        <p className={MUTED}>
          Pick the "Jev at …" arrows above (ideally at {fmtRead(botReadSec)},
          the bot's read) to backtest on this chart's past candles.
        </p>
      ) : !r ? (
        <p className={MUTED}>No Jev reads at {readLabel} on this chart yet.</p>
      ) : (
        <>
          <table className="w-full tabular-nums">
            <thead className={MUTED}>
              <tr>
                <th className="pb-1 text-left font-medium">
                  On candles read at {readLabel}
                </th>
                <th className="pb-1 text-right font-medium">Won</th>
                <th className="pb-1 text-right font-medium">Bets</th>
                <th className="pb-1 text-right font-medium">If all filled</th>
                <th
                  className="pb-1 text-right font-medium"
                  title="Bets whose side got down to the limit price after the read / bets with Polymarket prices"
                >
                  Filled
                </th>
                <th className="pb-1 text-right font-medium">Won (filled)</th>
                <th className="pb-1 text-right font-medium">Real P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {row("Bot rule (all bets)", r.bot, "bot", true)}
              {row("· flip calls with the EMAs", r.flips, "flips")}
              {row("· hold calls with the EMAs", r.holdsEma, "holdsEma")}
              {row(
                `· EMAs under $${emaGap}: hold = last candle, EMAs against → against Jev`,
                r.chop,
                "chop",
              )}
              {row(
                `· EMAs under $${emaGap}: flip with the EMAs, last candle opposite`,
                r.chopFlips,
                "chopFlips",
              )}
              {row("Every flip call, no EMA check", r.flipsAll, "flipsAll")}
              {row("Every hold call, no EMA check", r.holdsAll, "holdsAll")}
            </tbody>
          </table>
          <p className={`mt-1 ${MUTED}`}>
            {reads.length} candles with a Jev read at {readLabel}
            {pastIsLive
              ? " (this browser's own live reads: 30s can't be replayed from history)"
              : " (replayed history plus live reads)"}
            . Skipped because the EMAs disagreed with Jev or were less than $
            {emaGap} apart: {r.skippedFlips} flip calls, {r.skippedHolds} hold
            calls.
            {flipNeedsRegime
              ? ` ${r.skippedFlipsRegime} more flip calls skipped because the regime wasn't "Jev right".`
              : ""}{" "}
            "Won" = the candle closed the bet's color. Each bet is {limitShares}{" "}
            shares at {Math.round(limitPrice * 100)}¢: a win pays{" "}
            {Math.round((1 - limitPrice) * 100)}¢ a share and a loss costs{" "}
            {Math.round(limitPrice * 100)}¢, so it needs to win more than{" "}
            {Math.round(limitPrice * 100)}% of filled orders. A limit order only
            fills if the side gets that cheap, which happens most on the bets
            that end up losing, so "If all filled" is the best case. "Filled"
            checks Polymarket's own price history: a bet counts as filled if its
            side cost {Math.round(limitPrice * 100)}¢ or less at any point after
            the read and before the window ended; "Won (filled)" and "Real
            P&amp;L" count only those. Polymarket keeps about one price a
            minute, so a quick dip between points is missed (fills are, if
            anything, undercounted), and price history only covers the last 24
            hours the bot has collected ({ptsBy.size} windows so far).
            {readSec !== botReadSec
              ? ` The bot reads at ${fmtRead(botReadSec)}, so this is a stand-in.`
              : ""}
            {emaTf !== 5
              ? ` The bot uses ${emaTf}m EMAs; this uses the chart's 5m EMAs.`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}
