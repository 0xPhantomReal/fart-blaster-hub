import { useEffect, useState } from "react";
import { fadeBotStatus, type FadeBotStatus } from "./feed";

const MUTED = "text-[#8b949e]";
const money = (v: number) =>
  `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;

/** Read-only view of the Polymarket bot running in the backend. */
export function FadeBotPanel() {
  const [s, setS] = useState<FadeBotStatus | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () => fadeBotStatus().then((r) => alive && setS(r));
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (s === undefined) return null;
  if (s === null)
    return (
      <p className={`text-xs ${MUTED}`}>
        Not running yet: deploy the <code>fadebot</code> function and schedule
        it every minute.
      </p>
    );
  const st = s.state;
  const cfg = s.settings;
  return (
    <div className="text-sm">
      <p className={`mb-2 text-xs ${MUTED}`}>
        BTC 5-minute market on Polymarket US. Jev reads each candle 30 seconds
        in; when it says the candle holds its color, the bot market-buys that
        side (Fibonacci stakes from ${cfg.baseBet}) and places a limit order for{" "}
        {cfg.limitShares} more shares at {Math.round(cfg.limitPrice * 100)}¢
        until the window closes. Flip calls are ignored.
      </p>
      <div className="mb-2 grid grid-cols-2 gap-1 tabular-nums">
        <span>
          Mode:{" "}
          <b
            className={
              cfg.mode === "live" ? "text-[#ef5350]" : "text-[#d4a72c]"
            }
          >
            {cfg.mode === "live" ? "LIVE" : "dry run"}
          </b>
        </span>
        <span>
          Next bet: ${s.nextStake.toFixed(2)} (step {st.step})
        </span>
        <span>
          Won {st.wins} of {st.trades}
          {st.trades ? ` (${Math.round((st.wins / st.trades) * 100)}%)` : ""}
        </span>
        <span
          className={st.total_pnl >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}
        >
          P&amp;L {money(st.total_pnl)}
        </span>
        <span className={`col-span-2 text-xs ${MUTED}`}>
          Worst drawdown so far: ${st.worst_drawdown.toFixed(2)}
        </span>
      </div>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className={MUTED}>
            <th className="pb-1 text-left font-medium">Window</th>
            <th className="pb-1 text-left font-medium">Jev</th>
            <th className="pb-1 text-left font-medium">Bets</th>
            <th className="pb-1 text-right font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {s.bets.slice(0, 12).map((b) => (
            <tr
              key={String(b.window_start)}
              className="border-t border-[#262c36]"
            >
              <td className="py-1">
                {new Date(Number(b.window_start) * 1000).toLocaleTimeString(
                  [],
                  { hour: "numeric", minute: "2-digit" },
                )}
              </td>
              {b.status === "skipped" || b.status === "void" ? (
                <td colSpan={3} className={`py-1 ${MUTED}`}>
                  {b.status === "void" ? "couldn't settle" : b.reason}
                </td>
              ) : (
                <>
                  <td className="py-1">
                    holds{" "}
                    {b.jev_sure !== null
                      ? `${Math.round(b.jev_sure * 100)}%`
                      : ""}
                  </td>
                  <td className="py-1">
                    {b.side} ${b.stake?.toFixed(0)} @ {b.price?.toFixed(2)}
                    <span className={MUTED}>
                      {" "}
                      + {b.limit_shares} @{" "}
                      {Math.round((b.limit_price ?? 0) * 100)}¢{" "}
                      {b.limit_filled
                        ? "filled"
                        : b.status === "open"
                          ? "waiting"
                          : "not filled"}
                    </span>
                  </td>
                  <td
                    className={`py-1 text-right ${b.result === "win" ? "text-[#26a69a]" : b.result === "loss" ? "text-[#ef5350]" : MUTED}`}
                  >
                    {b.status === "open"
                      ? "open"
                      : `${b.result} ${money(b.pnl ?? 0)}`}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
