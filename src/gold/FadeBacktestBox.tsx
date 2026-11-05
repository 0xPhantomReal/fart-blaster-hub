import { useEffect, useMemo, useState } from "react";
import { backtest, Tv15, type Read, type Tally } from "./fadeBacktest";
import { fetchCandles } from "./feed";
import type { ClosedBar } from "./useGold";

const MUTED = "text-[#8b949e]";
const GREEN = "text-[#26a69a]";
const RED = "text-[#ef5350]";

/** BTC 15-minute candles for the TV indicator (the same 3,000 the 15m chart loads), refreshed every 5 minutes. */
function useTv15() {
  const [tv, setTv] = useState<Tv15 | null | "error">(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const now = Date.now() / 1000;
        const c = await fetchCandles("btc", 15, now - 3000 * 900 * 1.7, now);
        const closed = c.filter((x) => x.time + 900 <= now).slice(-3000);
        if (alive) setTv(new Tv15(closed));
      } catch {
        if (alive) setTv((v) => (v instanceof Tv15 ? v : "error"));
      }
    };
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return tv;
}

/**
 * How the bot's rule would have done on past candles, from the page's own "Jev at …" reads:
 * fade Jev's call when it's in the bot's range AND goes against the 15m TV indicator.
 */
export function FadeBacktestBox({
  bars,
  readSec,
  readLabel,
  pastIsLive,
  min,
  max,
  botReadSec,
}: {
  bars: ClosedBar[];
  readSec: number | null; //   the "Jev at …" read the chart is showing (null = not a minute read)
  readLabel: string;
  pastIsLive: boolean; //       30s: the record is this browser's own reads, not a replay
  min: number;
  max: number;
  botReadSec: number;
}) {
  const tv = useTv15();
  const reads: Read[] = useMemo(
    () =>
      bars
        .filter((b) => b.pMin !== undefined)
        .map((b) => ({
          time: b.candle.time,
          pJev: b.pMin!,
          y:
            b.candle.close > b.candle.open
              ? 1
              : b.candle.close < b.candle.open
                ? 0
                : null,
        })),
    [bars],
  );
  const r = useMemo(
    () =>
      tv instanceof Tv15 && readSec !== null
        ? backtest(reads, tv, readSec, min, max)
        : null,
    [tv, reads, readSec, min, max],
  );
  const rate = (x: Tally) => (x.n ? x.wins / x.n : null);
  const cell = (x: Tally, strong = false) => {
    const p = rate(x);
    return (
      <>
        <td
          className={`py-0.5 text-right ${strong ? "font-bold" : ""} ${p === null ? MUTED : p > 0.5 ? GREEN : p < 0.5 ? RED : ""}`}
        >
          {p === null ? "—" : `${(p * 100).toFixed(1)}%`}
        </td>
        <td className={`py-0.5 text-right ${MUTED}`}>{x.n}</td>
      </>
    );
  };
  return (
    <div className="mt-3 rounded-md border border-[#262c36] p-2 text-xs">
      <div className="mb-1 font-semibold">Backtest of the bot's rule</div>
      {readSec === null ? (
        <p className={MUTED}>
          Pick the "Jev at …" arrows above (ideally at{" "}
          {botReadSec < 60 ? `${botReadSec}s` : `${botReadSec / 60} min`}, the
          bot's read) to backtest on this chart's past candles.
        </p>
      ) : tv === null ? (
        <p className={MUTED}>Loading the 15-minute candles…</p>
      ) : tv === "error" ? (
        <p className={MUTED}>
          Couldn't load the 15-minute candles for the indicator.
        </p>
      ) : !r || !reads.length ? (
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
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-0.5">
                  Bot rule: fade Jev only against the 15m indicator
                </td>
                {cell(r.bot, true)}
              </tr>
              <tr>
                <td className="py-0.5">
                  Fade every call {Math.round(min * 100)}–
                  {Math.round(max * 100)}% (no 15m check)
                </td>
                {cell(r.fadeAll)}
              </tr>
              <tr>
                <td className="py-0.5">Follow Jev on those same calls</td>
                {cell(r.jevInRange)}
              </tr>
              <tr>
                <td className="py-0.5">Follow the 15m indicator alone</td>
                {cell(r.tvAlone)}
              </tr>
            </tbody>
          </table>
          <p className={`mt-1 ${MUTED}`}>
            {reads.length} candles with a Jev read at {readLabel}
            {pastIsLive
              ? " (this browser's own live reads: 30s can't be replayed from history)"
              : " (replayed history plus live reads)"}
            . Skipped by the 15m check: {r.skippedAgree} where the indicator
            agreed with Jev, {r.skippedNoCall} where it showed no call. "Won" =
            the candle closed the bet's color. Each bet buys at roughly the
            market price, so it needs to win more often than that price (about
            50¢ plus fees) to make money.
            {readSec !== botReadSec
              ? ` The bot reads at ${botReadSec < 60 ? `${botReadSec}s` : `${botReadSec / 60} min`}, so this is a stand-in.`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}
