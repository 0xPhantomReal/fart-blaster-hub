import { useEffect, useState } from "react";
import { fadeBotFindMarket, fadeBotStatus, type FadeBotStatus } from "./feed";

const MUTED = "text-[#8b949e]";
const money = (v: number) =>
  `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;

/** Read-only view of the Polymarket bot running in the backend. */
export function FadeBotPanel() {
  const [s, setS] = useState<FadeBotStatus | null | undefined>(undefined);
  const [check, setCheck] = useState<string | null>(null);
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
        BTC 5-minute market on Polymarket US. Jev reads each candle{" "}
        {cfg.readAt ? `${cfg.readAt / 60} minutes` : "3 minutes"} in. When its
        call is over 50% and at most {Math.round((cfg.fadeMax ?? 0.7) * 100)}%
        sure (hold or flip), the bot places a ${cfg.marketBet} market order on
        the <b>other</b> side. Surer calls and 50% calls: no bet. Same stake
        every time.
        {cfg.limitShares > 0
          ? ` Plus a limit order for ${cfg.limitShares} shares at ${Math.round(cfg.limitPrice * 100)}¢.`
          : ""}
      </p>
      {s.regime && (
        <p className={`mb-2 text-xs ${MUTED}`}>
          For reference: Jev was right on {s.regime.right} of its last{" "}
          {s.regime.n} reads
          {s.regime.afterHit.n >= 10 && s.regime.afterMiss.n >= 10
            ? `; after a hit it's right ${Math.round((s.regime.afterHit.right / s.regime.afterHit.n) * 100)}%, after a miss ${Math.round((s.regime.afterMiss.right / s.regime.afterMiss.n) * 100)}%`
            : ""}
          .
        </p>
      )}
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
          Max per window: $
          {(cfg.limitShares * cfg.limitPrice + cfg.marketBet).toFixed(2)}
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
      <button
        className="mb-2 rounded border border-[#262c36] px-2 py-0.5 text-xs text-[#8b949e] hover:bg-[#1f252e]"
        onClick={async () => {
          setCheck("checking…");
          const r = await fadeBotFindMarket();
          setCheck(
            "error" in r
              ? `error: ${r.error}`
              : r.market
                ? `found ${r.market.slug} (YES pays on ${r.market.longIs}${r.how ? `, from ${r.how}` : ""}) for the window starting ${new Date(r.window).toLocaleTimeString()}${r.check ? `. Check against settled windows: ${r.check.ok === true ? "OK" : r.check.ok === false ? "MISMATCH" : "pending"}, ${r.check.note}` : ""}${r.record && r.record !== "null" ? `. Market record: ${r.record}` : ""}`
                : `not found: ${r.search}${r.record && r.record !== "null" ? `. Market record: ${r.record}` : ""}`,
          );
        }}
      >
        Check Polymarket market
      </button>
      {check && <p className={`mb-2 break-all text-xs ${MUTED}`}>{check}</p>}
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
                    {b.kind === "fade-hold"
                      ? "holds (faded)"
                      : b.kind === "fade-flip"
                        ? "flip (faded)"
                        : "holds"}{" "}
                    {b.jev_sure !== null
                      ? `${Math.round(b.jev_sure * 100)}%`
                      : ""}
                  </td>
                  <td className="py-1" title={b.reason ?? undefined}>
                    {b.side}
                    {b.shares
                      ? ` $${b.stake?.toFixed(0)} @ ${b.price?.toFixed(2)}`
                      : b.stake
                        ? ` $${b.stake.toFixed(0)} (no fill)`
                        : ""}
                    {b.limit_shares ? (
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
                    ) : null}
                    {b.reason ? <span className={MUTED}> ⓘ</span> : null}
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
