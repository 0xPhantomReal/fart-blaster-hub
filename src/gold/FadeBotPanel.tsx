import type { TraderStatus } from "./feed";
import { useEffect, useState } from "react";
import { FadeBacktestBox } from "./FadeBacktestBox";
import { fadeBotFindMarket, fadeBotStatus, type FadeBotStatus } from "./feed";
import type { ClosedBar } from "./useGold";

const MUTED = "text-[#8b949e]";
const money = (v: number) =>
  `${v < 0 ? "−" : v > 0 ? "+" : ""}$${Math.abs(v).toFixed(2)}`;

/** Read-only view of the Polymarket bot running in the backend. */
export function FadeBotPanel({
  bars,
  readSec,
  readLabel,
  pastIsLive,
}: {
  bars: ClosedBar[];
  readSec: number | null;
  readLabel: string;
  pastIsLive: boolean;
}) {
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
  const bt = (
    botReadSec: number,
    limitPrice: number,
    limitShares: number,
    emaTf: number,
    emaGap: number,
    flipNeedsRegime: boolean,
  ) => (
    <FadeBacktestBox
      bars={bars}
      readSec={readSec}
      readLabel={readLabel}
      pastIsLive={pastIsLive}
      botReadSec={botReadSec}
      limitPrice={limitPrice}
      limitShares={limitShares}
      emaTf={emaTf}
      emaGap={emaGap}
      flipNeedsRegime={flipNeedsRegime}
      pmPoints={s?.pmPoints}
    />
  );
  if (s === undefined) return null;
  if (s === null)
    return (
      <>
        <p className={`text-xs ${MUTED}`}>
          Not running yet: deploy the <code>fadebot</code> function and schedule
          it every minute.
        </p>
        {bt(30, 0.33, 15, 5, 30, true)}
      </>
    );
  const st = s.state;
  const cfg = s.settings;
  return (
    <div className="text-sm">
      {cfg.strategy === "jev-trader" ? (
        <TraderPanel t={s.trader ?? null} cfg={cfg} />
      ) : cfg.strategy === "lightspeed" ? (
        <div className={`mb-2 space-y-1 text-xs ${MUTED}`}>
          <p>
            BTC 5-minute market on Polymarket US, Lightspeed rules (Jev isn't
            asked). The bot scores each candle's strength live, from 0 to 100:
            how big the move is for the time elapsed, where price sits in the
            candle's range, aggressive buying vs selling, the order books, and
            ETH/SOL.
          </p>
          <p>
            <b>Strong:</b> from {cfg.strongFromSec ?? 60} to{" "}
            {cfg.strongToSec ?? 240} seconds in, once the candle is{" "}
            {cfg.strongMin ?? 60}+ strong in the direction it's moving, the bot
            market-buys ${cfg.strongBet ?? 5} of that side and holds it to
            settlement.
          </p>
          {cfg.lsFade ? (
            <p>
              <b>Fade:</b> in the first {cfg.lsWindowSec ?? 120} seconds, a move
              bigger than Lightspeed's typical move that is <i>not</i> strong
              gets faded: ${cfg.lsBet ?? 1} market buy of the other side,
              market-sold at {cfg.takeProfit ?? 2}× the price (
              {Math.round(((cfg.takeProfit ?? 2) - 1) * 100)}% profit) or held
              to settlement. A big move that is strong is bought with instead
              (from {cfg.strongFromSec ?? 60} s). At most one bet per window.
            </p>
          ) : (
            <p>At most one bet per window. Big moves are no longer faded.</p>
          )}
          {s.strength && s.strength.windows > 0 ? (
            <StrengthTable st={s.strength} min={cfg.strongMin ?? 60} />
          ) : null}
        </div>
      ) : (
        <p className={`mb-2 text-xs ${MUTED}`}>
          BTC 5-minute market on Polymarket US. Jev reads each candle{" "}
          {!cfg.readAt
            ? "30 seconds"
            : cfg.readAt < 60
              ? `${cfg.readAt} seconds`
              : `${cfg.readAt / 60} minute${cfg.readAt === 60 ? "" : "s"}`}{" "}
          in. The bot bets with Jev's call, hold or flip, only when the{" "}
          {cfg.emaTf ?? 5}m EMAs agree: up when the fast EMA is above the slow
          one, down when it's below
          {cfg.emaGap
            ? `, and only when they're at least $${cfg.emaGap} apart`
            : ""}
          .{" "}
          {cfg.flipNeedsRegime
            ? ' Flip calls also need the regime to be "Jev right" (Jev right on more than half of its last 12 reads). '
            : " "}
          When the EMAs are closer than ${cfg.emaGap ?? 30}, it bets against a
          hold call that's the same color as the last candle when the EMAs point
          against Jev, and with a flip call when the EMAs agree and the last
          candle was the opposite color. Otherwise no bet. Each bet is a limit
          order for {cfg.limitShares} shares at{" "}
          {Math.round(cfg.limitPrice * 100)}¢ ($
          {(cfg.limitShares * cfg.limitPrice).toFixed(2)} if it fills), good
          until the window closes
          {cfg.marketBet > 0 ? `, plus a $${cfg.marketBet} market order` : ""}.
        </p>
      )}
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
      {cfg.strategy === "jev-trader" ? null : (
        <>
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
              {st.trades
                ? ` (${Math.round((st.wins / st.trades) * 100)}%)`
                : ""}
            </span>
            <span
              className={
                st.total_pnl >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"
              }
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
                        {b.kind === "ls-strong"
                          ? `Lightspeed: strong ${b.side === "up" ? "green ↑" : "red ↓"}`
                          : b.kind === "ls-fade"
                            ? `Lightspeed: fade the ${b.side === "up" ? "drop" : "jump"}`
                            : b.kind === "hold-with-chop" ||
                                b.kind === "flip-with-chop"
                              ? `Jev ${b.side === "up" ? "green ↑" : "red ↓"} (${b.kind === "flip-with-chop" ? "flip" : "holds"}), EMAs close → with`
                              : b.kind === "hold-fade-chop" ||
                                  b.kind === "flip-fade-chop"
                                ? `Jev ${b.side === "up" ? "red ↓" : "green ↑"} (${b.kind === "flip-fade-chop" ? "flip" : "holds"}), EMAs close → against`
                                : b.kind === "flip-ema" || b.kind === "hold-ema"
                                  ? `Jev ${b.side === "up" ? "green ↑" : "red ↓"} (${b.kind === "flip-ema" ? "flip" : "holds"}) + EMAs`
                                  : b.kind === "flip-follow"
                                    ? "flip → with Jev"
                                    : b.kind === "flip-fade"
                                      ? "flip → other side"
                                      : b.kind === "fade-hold"
                                        ? "holds (faded)"
                                        : b.kind === "fade-flip"
                                          ? "flip (faded)"
                                          : "holds"}{" "}
                        {b.jev_sure !== null
                          ? `${Math.round(b.jev_sure * 100)}%`
                          : ""}
                        {b.tv15 ? (
                          <div className={`text-[10px] ${MUTED}`}>{b.tv15}</div>
                        ) : null}
                      </td>
                      <td className="py-1" title={b.reason ?? undefined}>
                        {b.side}
                        {b.shares
                          ? ` $${b.stake?.toFixed(0)} @ ${b.price?.toFixed(2)}`
                          : b.stake
                            ? ` $${b.stake.toFixed(0)} (no fill)`
                            : ""}
                        {b.kind === "ls-strong" && b.shares ? (
                          <span className={MUTED}> → hold</span>
                        ) : null}
                        {b.kind === "ls-fade" && b.shares ? (
                          <span className={MUTED}>
                            {" "}
                            {b.exit_price != null
                              ? `→ sold @ ${b.exit_price.toFixed(2)}`
                              : b.target_price != null
                                ? `→ sell @ ${b.target_price.toFixed(2)}${b.status === "open" ? "" : " (not reached)"}`
                                : "→ held"}
                          </span>
                        ) : null}
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
                        className={`py-1 text-right ${b.result === "win" || (b.result === "sold" && (b.pnl ?? 0) > 0) ? "text-[#26a69a]" : b.result === "loss" ? "text-[#ef5350]" : MUTED}`}
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
        </>
      )}
      <button
        className="mb-2 rounded border border-[#262c36] px-2 py-0.5 text-xs text-[#8b949e] hover:bg-[#1f252e]"
        onClick={async () => {
          setCheck("checking…");
          const r = await fadeBotFindMarket();
          setCheck(
            "error" in r
              ? `error: ${r.error}`
              : r.market
                ? `found ${r.market.slug} (YES pays on ${r.market.longIs}${r.how ? `, from ${r.how}` : ""}) for the window starting ${new Date(r.window).toLocaleTimeString()}${r.check ? `. Check against settled windows: ${r.check.ok === true ? "OK" : r.check.ok === false ? "MISMATCH" : "pending"}, ${r.check.note}` : ""}${r.record && r.record !== "null" ? `. Market record: ${r.record}` : ""}${r.prices ? `. Prices — used: ${r.prices.used}; bbo: ${r.prices.bbo}; book: ${r.prices.book}; market: ${r.prices.market}` : ""}`
                : `not found: ${r.search}${r.record && r.record !== "null" ? `. Market record: ${r.record}` : ""}`,
          );
        }}
      >
        Check Polymarket market
      </button>
      {check && <p className={`mb-2 break-all text-xs ${MUTED}`}>{check}</p>}
      {s.pmHistory && <PmHistory s={s} readAt={cfg.readAt ?? 30} />}
      {bt(
        cfg.readAt ?? 30,
        cfg.limitPrice,
        cfg.limitShares,
        cfg.emaTf ?? 5,
        cfg.emaGap ?? 0,
        cfg.flipNeedsRegime ?? false,
      )}
    </div>
  );
}

const cents = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(v * 100)}¢`;

/** Polymarket's prices for each recent window: lowest Up and Down during the window, prices at the read, result. */
function PmHistory({ s, readAt }: { s: FadeBotStatus; readAt: number }) {
  const rows = s.pmHistory ?? [];
  const bets = new Map(s.bets.map((b) => [Number(b.window_start), b]));
  const failed = rows.find((r) => r.n_points === 0 && r.sample);
  const read = readAt < 60 ? `${readAt}s` : `${readAt / 60}m`;
  return (
    <div className="mt-3 rounded-md border border-[#262c36] p-2 text-xs">
      <div className="mb-1 font-semibold">Polymarket prices per window</div>
      <p className={`mb-1 ${MUTED}`}>
        From Polymarket's price history, about one price a minute (the cost to
        buy each side), so the true low between minutes can be lower. Last 6
        hours, filled in a few minutes after each window ends.
      </p>
      {!rows.length ? (
        <p className={MUTED}>
          Nothing yet: the bot fills this in on its next runs.
        </p>
      ) : (
        <table className="w-full tabular-nums">
          <thead className={MUTED}>
            <tr>
              <th className="pb-1 text-left font-medium">Window</th>
              <th className="pb-1 text-right font-medium">Low Up</th>
              <th className="pb-1 text-right font-medium">Low Down</th>
              <th className="pb-1 text-right font-medium">At {read} Up/Down</th>
              <th className="pb-1 text-right font-medium">Ended</th>
              <th className="pb-1 text-right font-medium">Bot</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const b = bets.get(Number(r.window_start));
              return (
                <tr
                  key={String(r.window_start)}
                  className="border-t border-[#1b2028]"
                  title={r.error ?? undefined}
                >
                  <td className="py-0.5">
                    {new Date(Number(r.window_start) * 1000).toLocaleTimeString(
                      [],
                      { hour: "numeric", minute: "2-digit" },
                    )}
                  </td>
                  {r.n_points ? (
                    <>
                      <td className="py-0.5 text-right">{cents(r.up_low)}</td>
                      <td className="py-0.5 text-right">{cents(r.down_low)}</td>
                      <td className={`py-0.5 text-right ${MUTED}`}>
                        {cents(r.up_read)} / {cents(r.down_read)}
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} className={`py-0.5 text-right ${MUTED}`}>
                      {r.error ?? "no data"}
                    </td>
                  )}
                  <td
                    className={`py-0.5 text-right ${r.outcome === "up" ? "text-[#26a69a]" : r.outcome === "down" ? "text-[#ef5350]" : MUTED}`}
                  >
                    {r.outcome ?? "—"}
                  </td>
                  <td className={`py-0.5 text-right ${MUTED}`}>
                    {b && b.status !== "skipped" && b.side
                      ? `${b.side}${b.price ? ` @ ${cents(b.price)}` : ""}${b.result ? ` ${b.result}` : ""}`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {failed && (
        <p className={`mt-1 break-all ${MUTED}`}>
          Price history not readable yet. What Polymarket returned:{" "}
          {failed.sample}
        </p>
      )}
      {rows.some((r) => r.long_is === "up?") && (
        <p className={`mt-1 ${MUTED}`}>
          "Up" assumes the Yes side pays on Up (it couldn't be read from the
          market for some windows).
        </p>
      )}
    </div>
  );
}

/** How often candles finished the way their strength pointed, by checkpoint (rows) and strength (columns). */
function StrengthTable({
  st,
  min,
}: {
  st: {
    windows: number;
    rows: { at: number; from: number; n: number; theirWay: number }[];
  };
  min: number;
}) {
  const froms = [0, 20, 40, 60, 80];
  return (
    <div className="mt-1">
      <div className="mb-0.5">
        How often the candle finished the way its strength pointed (last 7 days,{" "}
        {st.windows} candles):
      </div>
      <table className="w-full tabular-nums">
        <thead>
          <tr>
            <th className="text-left font-normal">at</th>
            {froms.map((f) => (
              <th
                key={f}
                className={`text-right font-normal ${f >= min ? "text-[#c9d1d9]" : ""}`}
              >
                {f}–{f + 20}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[60, 120, 180, 240].map((at) => (
            <tr key={at}>
              <td>{at} s</td>
              {froms.map((f) => {
                const r = st.rows.find((x) => x.at === at && x.from === f);
                return (
                  <td
                    key={f}
                    className="text-right"
                    title={r ? `${r.theirWay} of ${r.n}` : undefined}
                  >
                    {r && r.n
                      ? `${Math.round((r.theirWay / r.n) * 100)}% (${r.n})`
                      : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : `${Math.round(x * 100)}`;
const usd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const hhmm = (t: number | string) =>
  new Date(Number(t) * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

/** Jev trader: Jev asked constantly whether to buy, sell or wait; its trades; and whether it beats the price. */
function TraderPanel({
  t,
  cfg,
}: {
  t: TraderStatus | null;
  cfg: FadeBotStatus["settings"];
}) {
  const tc = cfg.trader;
  const open = t?.trades.find((x) => x.status === "open");
  const last = t?.asks[0];
  return (
    <div className={`mb-2 space-y-2 text-xs ${MUTED}`}>
      <p>
        <b className="text-[#c9d1d9]">Jev trader</b>{" "}
        {t?.live ? (
          <b className="text-[#ef5350]">LIVE</b>
        ) : (
          <b>test mode (no real orders)</b>
        )}
        . Jev is asked over and over — a new question as soon as the last answer
        is in — with the candle, Lightspeed, candle strength, the live market
        data, Polymarket's prices and the position: buy Up, buy Down or wait.{" "}
        {tc?.sell
          ? "Holding, it's asked whether to sell or hold."
          : "Once it buys, the position is held to settlement (no early selling)."}
        {tc?.invert ? (
          <>
            {" "}
            <b className="text-[#d4a72c]">Fading Jev:</b> when Jev's buy passes
            the checks below, the bot buys the <i>other</i> side for the same
            amount.
          </>
        ) : null}
        {tc
          ? ` A buy goes ahead only if Jev's chance beats the price by ${Math.round(tc.edge * 100)}+ points; size is ${tc.allIn ? "ALL-IN (the whole balance on every buy — one loss empties it)" : `${tc.kelly} Kelly of $${tc.bankroll}, $${tc.minBet}–$${tc.maxBet}`}, up to ${tc.maxEntries} buys a window, none in the last ${tc.minLeftSec} s,${tc.banLo !== undefined && tc.banHi !== undefined ? ` none at ${Math.round(tc.banLo * 100)}–${Math.round(tc.banHi * 100)}¢,` : ""} and no buys after losing $${tc.dailyLoss} in a day.`
          : ""}
      </p>
      {!t ? (
        <p>Waiting for the bot.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 text-[#c9d1d9]">
            <span>
              Trades {t.totals?.n ?? 0}, won {t.totals?.wins ?? 0}
            </span>
            <span
              className={
                (t.totals?.pnl ?? 0) >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"
              }
            >
              P&amp;L {usd(Number(t.totals?.pnl ?? 0))}
            </span>
            <span>Today {usd(t.today)}</span>
          </div>
          {open ? (
            <p className="text-[#c9d1d9]">
              Holding {open.side === "up" ? "Up" : "Down"}:{" "}
              {open.shares.toFixed(2)} shares @ {open.price.toFixed(2)} ($
              {open.stake.toFixed(2)})
              {last?.unrealized != null
                ? `, unrealized ${usd(last.unrealized)}`
                : ""}
            </p>
          ) : null}
          {last ? (
            <p>
              Last ask ({hhmm(last.window_start)} window,{" "}
              {Math.round(last.at_sec)} s): Jev {last.action ?? "—"},{" "}
              {pct(last.p_up)}% green, Up costs {pct(last.up_cost)}¢, Down{" "}
              {pct(last.down_cost)}¢ → {last.did ?? "—"}
              {last.ms ? ` (${(last.ms / 1000).toFixed(1)} s)` : ""}
            </p>
          ) : null}
          {t.edge && t.edge.some((e) => e.n) ? (
            <div>
              <div className="mb-0.5">
                Does Jev beat the price? Every ask's favoured side, by Jev's
                chance minus what that side cost (one ask per candle per row,
                last 7 days):
              </div>
              <table className="w-full tabular-nums">
                <thead>
                  <tr>
                    <th className="text-left font-normal">Edge</th>
                    <th className="text-right font-normal">Candles</th>
                    <th className="text-right font-normal">Won</th>
                    <th className="text-right font-normal">Avg cost</th>
                    <th className="text-right font-normal">Per $1</th>
                  </tr>
                </thead>
                <tbody>
                  {t.edge.map((e, i, a) => (
                    <tr key={e.from}>
                      <td>
                        {e.from < 0
                          ? "below 0"
                          : i === a.length - 1
                            ? `${e.from}+ pts`
                            : `${e.from}–${a[i + 1].from} pts`}
                      </td>
                      <td className="text-right">{e.n}</td>
                      <td className="text-right">
                        {e.winPct === null ? "—" : `${e.winPct}%`}
                      </td>
                      <td className="text-right">
                        {e.avgCost === null
                          ? "—"
                          : `${Math.round(e.avgCost * 100)}¢`}
                      </td>
                      <td
                        className={`text-right ${e.returnPerDollar === null ? "" : e.returnPerDollar >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}`}
                      >
                        {e.returnPerDollar === null
                          ? "—"
                          : usd(e.returnPerDollar)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-0.5">
                "Per $1" is what each dollar would have made buying that side at
                that price and holding. If the higher-edge rows aren't clearly
                positive after a few hundred candles, Jev isn't seeing anything
                the price misses.
              </div>
            </div>
          ) : (
            <p>
              The "does Jev beat the price?" table fills in as candles finish.
            </p>
          )}
          {t.trades.length ? (
            <table className="w-full tabular-nums">
              <thead>
                <tr>
                  <th className="text-left font-normal">Window</th>
                  <th className="text-left font-normal">Trade</th>
                  <th className="text-right font-normal">Result</th>
                </tr>
              </thead>
              <tbody className="text-[#c9d1d9]">
                {t.trades.slice(0, 15).map((x) => (
                  <tr key={x.id}>
                    <td className="py-0.5">{hhmm(x.window_start)}</td>
                    <td className="py-0.5">
                      {x.side === "up" ? "Up ↑" : "Down ↓"} $
                      {x.stake.toFixed(2)} @ {x.price.toFixed(2)} at{" "}
                      {Math.round(x.opened_sec)} s (Jev {pct(x.p_side)}%)
                      {x.exit_price != null
                        ? ` → sold @ ${x.exit_price.toFixed(2)} at ${Math.round(x.exit_sec ?? 0)} s`
                        : x.status === "open"
                          ? " → holding"
                          : " → held to the end"}
                      {x.mode === "dry" ? (
                        <span className={MUTED}> (test)</span>
                      ) : null}
                    </td>
                    <td
                      className={`py-0.5 text-right ${x.pnl == null ? MUTED : x.pnl >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}`}
                    >
                      {x.pnl == null ? x.status : usd(x.pnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      )}
    </div>
  );
}
