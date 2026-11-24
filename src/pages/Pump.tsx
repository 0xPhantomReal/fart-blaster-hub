import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPumpExport, fetchPumpStatus, type PumpStatus } from "@/gold/feed";

/** /pump — the pump bot: buys a cheap side (under 30¢) when Jev expects a +100% pump; sells at +100%, −50% or late. */
const signed = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const tone = (x: number | null | undefined) =>
  x === null || x === undefined || x === 0 ? "text-[#c9d1d9]" : x > 0 ? "text-[#26a69a]" : "text-[#ef5350]";
const c = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}¢`);
const hhmm = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const pad = (k: string, d: string) => `${k.padEnd(20)} ${d}`;
const card = "rounded-lg border border-[#30363d] bg-[#161b22] p-4";

const Pump = () => {
  const [s, setS] = useState<PumpStatus | null | undefined>(undefined);
  const [at, setAt] = useState<Date | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    document.title = "Pump bot";
    let alive = true;
    const load = () =>
      fetchPumpStatus().then((r) => {
        if (!alive) return;
        setS(r);
        setAt(new Date());
      });
    void load();
    const id = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const st = s?.settings;
  const tot = s?.totals.find((t) => t.mode === s.mode && (t.kind ?? "pump") === "pump");
  const seeTot = s?.totals.find((t) => t.mode === s.mode && t.kind === "seesaw");
  const open = s?.trades.find((t) => t.status === "open" && (t.kind ?? "pump") === "pump");
  const seeOpen = (s?.trades ?? []).filter((t) => t.status === "open" && t.kind === "seesaw").length;
  const ran = s?.lastRun ? Math.round(Date.now() / 1000 - s.lastRun.at) : null;
  const trades = (s?.trades ?? []).filter((t) => t.mode === s?.mode);
  const log = (s?.log ?? []).filter((l) => showAll || !/no buy$/.test(l.did) || (l.p_pump ?? 0) >= 0.3).slice(0, 40);

  return (
    <main className="min-h-screen bg-[#0e1116] px-4 py-6 text-[#c9d1d9]">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Pump bot</h1>
          <span className="text-xs text-[#8b949e]">
            <Link to="/bot" className="mr-3 underline">Fadebot</Link>
            {at ? `updated ${at.toLocaleTimeString()} · every 5 s` : "loading…"}
          </span>
        </header>

        {s === null ? (
          <p className="text-sm text-[#8b949e]">Can't reach the bot right now (deploy the fadebot edge function).</p>
        ) : (
          <section className={card}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                {st?.seesaw
                  ? `SEESAW: watches both sides under ${st.maxAsk}¢; every time a side's score reaches ${st.seesawScore}` +
                    `${st.seesawJev !== false ? ` and Jev gives ${Math.round((st.seesawJevMin ?? 0.5) * 100)}%+ that its bid reaches break-even after fees` : ""}, buys $${st.seesawBet} ` +
                    `(again every ${st.seesawEvery} s while it stays there, up to ${st.seesawMax} buys a window). ` +
                    `${st.seesawTp ? `Sells a buy at +${Math.round(st.seesawTp * 100)}% after fees; ` : ""}` +
                    `${st.seesawTarget ? `once the window's buys are +${Math.round(st.seesawTarget * 100)}% in total it sells the rest and stops; ` : ""}` +
                    "anything left holds to resolution."
                  : st
                  ? `Scores every cheap side (under ${st.maxAsk}¢) from the live book, trades and BTC. At ${st.minScore ?? 50}+ it asks Jev ` +
                    `and buys ${st.betPct ? `${st.betPct}% of the balance` : `$${st.bet}`} if Jev gives it ${st.jevRange ? `${st.jevRange.lo}–${st.jevRange.hi}%` : st.jevDir === "above" ? `${st.minProb}%+` : `under ${st.minProb}%`} to win` +
                    `${st.autoScore ? `; at ${st.autoScore}+ with flow ${st.autoFlow ?? 15}+ and turn ${st.autoTurn ?? 10}+ it buys without asking` : ""}. ` +
                    (st.hold
                      ? "Holds every buy to resolution."
                      : `Sells at +${st.tp}% or −${st.sl}%${st.exitSec ? `, or with ${st.exitSec} s left` : "; otherwise holds to resolution"}.`)
                  : "…"}
              </div>
              <span
                className={`rounded px-2 py-1 text-xs font-bold ${
                  st?.live ? "bg-[#3d1d1d] text-[#ef5350]" : "bg-[#21262d] text-[#8b949e]"
                }`}
              >
                {st?.on === false ? "OFF" : st?.live ? "LIVE" : "TEST"}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              <div>
                <div className="text-xs text-[#8b949e]">{st?.live ? "Polymarket balance" : "Paper balance"}</div>
                <div className="tabular-nums font-medium">
                  {s?.balance === null || s?.balance === undefined ? "—" : `$${s.balance.toFixed(2)}`}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#8b949e]">Today</div>
                <div className={`tabular-nums font-medium ${tone(s?.today)}`}>{signed(s?.today)}</div>
              </div>
              <div>
                <div className="text-xs text-[#8b949e]">All-time</div>
                <div className={`tabular-nums font-medium ${tone(tot ? Number(tot.pnl) : null)}`}>
                  {tot ? signed(Number(tot.pnl)) : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#8b949e]">Trades / won</div>
                <div className="tabular-nums font-medium">
                  {tot ? `${tot.n} / ${tot.wins} (${tot.n ? Math.round((tot.wins / tot.n) * 100) : 0}%)` : "0"}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#8b949e]">{st?.hold ? "Held to resolution" : "+100% / −50% / time"}</div>
                <div className="tabular-nums font-medium">
                  {!tot ? "—" : st?.hold ? `${tot.held ?? 0}` : `${tot.tp} / ${tot.sl} / ${tot.timed}`}
                </div>
              </div>
            </div>
            {seeTot || seeOpen ? (
              <div className="mt-3 text-sm">
                <span className="text-xs text-[#8b949e]">Seesaw: </span>
                {seeTot ? `${seeTot.n} settled, ${seeTot.wins} won (${seeTot.n ? Math.round((seeTot.wins / seeTot.n) * 100) : 0}%), ` : ""}
                <span className={`tabular-nums ${tone(seeTot ? Number(seeTot.pnl) : null)}`}>{seeTot ? signed(Number(seeTot.pnl)) : ""}</span>
                {seeOpen ? <span className="text-xs text-[#8b949e]"> · {seeOpen} open</span> : null}
              </div>
            ) : null}
            <div className="mt-3 text-xs text-[#8b949e]">
              {open
                ? `Holding ${open.side === "up" ? "Up" : "Down"}: ${open.shares.toFixed(2)} @ ${c(open.price)} — ${
                  st?.hold
                    ? `to resolution (pays $${open.shares.toFixed(2)} if ${open.side} wins)`
                    : `sells at ${c(open.price * (1 + (st?.tp ?? 100) / 100))} or ${c(open.price * (1 - (st?.sl ?? 50) / 100))}`
                }`
                : "No open position"}
              {" · "}
              {s?.lastRun
                ? `last run ${ran !== null && ran < 120 ? `${ran} s ago` : hhmm(s.lastRun.at)}: ${s.lastRun.did}`
                : "never run yet — needs its cron job (see below)"}
              {ran !== null && ran > 150 ? " ⚠ not running" : ""}
            </div>
          </section>
        )}

        <LiveRead s={s} />

        <Recorder s={s} />

        <section className={card}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Jev's calls</h2>
            <label className="text-xs text-[#8b949e]">
              <input type="checkbox" className="mr-1" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              show every "no"
            </label>
          </div>
          {log.length ? (
            <table className="w-full text-xs">
              <thead className="text-[#8b949e]">
                <tr className="text-left">
                  <th className="py-1">Time</th>
                  <th>Side</th>
                  <th>Ask</th>
                  <th>Jev</th>
                  <th>What happened</th>
                </tr>
              </thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id} className="border-t border-[#21262d] align-top">
                    <td className="py-1 pr-2 tabular-nums">{hhmm(Date.parse(l.created_at) / 1000)}</td>
                    <td className="pr-2">{l.side ?? ""}</td>
                    <td className="pr-2 tabular-nums">{l.ask !== null ? c(l.ask) : ""}</td>
                    <td className="pr-2 tabular-nums">{l.p_pump !== null ? `${Math.round(l.p_pump * 100)}%` : ""}</td>
                    <td className="text-[#8b949e]">{l.did}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-[#8b949e]">Nothing yet.</p>
          )}
        </section>

        <section className={card}>
          <h2 className="mb-2 text-sm font-semibold">Trades</h2>
          {trades.length ? (
            <table className="w-full text-xs">
              <thead className="text-[#8b949e]">
                <tr className="text-left">
                  <th className="py-1">Window</th>
                  <th>Side</th>
                  <th>Paid</th>
                  <th>Jev</th>
                  <th>Exit</th>
                  <th>Sold</th>
                  <th className="text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-t border-[#21262d]" title={t.reason ?? ""}>
                    <td className="py-1 tabular-nums">{hhmm(t.window_start)}</td>
                    <td>
                      {t.side}
                      {t.kind === "seesaw" ? <span className="ml-1 text-[10px] text-[#d29922]">seesaw</span> : null}
                    </td>
                    <td className="tabular-nums">{c(t.price)}</td>
                    <td className="tabular-nums">{t.p_pump !== null ? `${Math.round(t.p_pump * 100)}%` : ""}</td>
                    <td>{t.status === "open" ? "open" : t.exit_why ?? t.result}</td>
                    <td className="tabular-nums">{t.exit_price !== null ? c(t.exit_price) : ""}</td>
                    <td className={`text-right tabular-nums ${tone(t.pnl)}`}>{t.pnl !== null ? signed(t.pnl) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-[#8b949e]">No trades yet.</p>
          )}
        </section>

        <section className={`${card} text-xs text-[#8b949e]`}>
          <h2 className="mb-2 text-sm font-semibold text-[#c9d1d9]">Settings (Lovable Cloud → Secrets)</h2>
          <pre className="overflow-auto rounded bg-[#0e1116] p-2">
            {[
              pad(`PUMP_MODE=${st?.live ? "live" : "dry"}`, "live = real orders"),
              pad(`PUMP_BET=${st?.bet ?? 1}`, "$ per trade (when PUMP_BET_PCT is 0)"),
              pad(`PUMP_BET_PCT=${st?.betPct ?? 0}`, "% of balance per trade, at least $1 (0 = use PUMP_BET)"),
              pad(`PUMP_BANKROLL=${st?.bankroll ?? 100}`, "test mode's starting paper balance ($)"),
              pad(`PUMP_MAX_ASK=${st?.maxAsk ?? 30}`, "buy only under this (¢)"),
              pad(`PUMP_MIN_ASK=${st?.minAsk ?? 2}`, "…and at least this (¢)"),
              pad(`PUMP_HOLD=${st?.hold === false ? "0" : "1"}`, "1 = hold to resolution (no TP/SL/late sell); 0 = use the 3 below"),
              pad(`PUMP_TP=${st?.tp ?? 100}`, "take profit, % of price paid (on the bid)"),
              pad(`PUMP_SL=${st?.sl ?? 50}`, "stop loss, %"),
              pad(`PUMP_EXIT_SEC=${st?.exitSec ?? 0}`, "sell with this many seconds left (0 = off)"),
              pad(`PUMP_MIN_LEFT=${st?.minLeft ?? 200}`, "no buys with fewer seconds left"),
              pad(`PUMP_MAX_LEFT=${st?.maxLeft ?? 0}`, "no buys with more seconds left (0 = off; 45 = last 45 s only)"),
              pad(`PUMP_JEV_EVERY=${st?.jevEvery ?? 5}`, "ask Jev every N s while a side is cheap"),
              pad(`PUMP_MIN_PROB=${st?.minProb ?? 40}`, "Jev's win-chance line (%)"),
              pad(`PUMP_JEV_DIR=${st?.jevDir ?? "below"}`, "below = Jev UNDER the line; above = at/over it"),
              pad(`PUMP_JEV_RANGE=${st?.jevRange ? `${st.jevRange.lo}-${st.jevRange.hi}` : ""}`, "e.g. 10-11: buy only when Jev says 10–11% (overrides the line)"),
              pad(`PUMP_SLIP=${st?.slip ?? 2}`, "skip if the ask rose more than this (¢) while Jev thought"),
              pad(`PUMP_MAX_TRADES=${st?.maxTrades ?? 1}`, "buys per window"),
              pad(`PUMP_DAILY_LOSS=${st?.dailyLoss ?? 20}`, "stop buying for the day after losing this ($)"),
              pad(`PUMP_MIN_SCORE=${st?.minScore ?? 50}`, "microstructure score (0–100) needed before Jev is asked"),
              pad(`PUMP_AUTO_SCORE=${st?.autoScore ?? 60}`, "auto-buy without Jev: score at/above this (0 = off)…"),
              pad(`PUMP_AUTO_FLOW=${st?.autoFlow ?? 15}`, "…and buying pressure at/above this (of 20; 0 = not needed)"),
              pad(`PUMP_AUTO_TURN=${st?.autoTurn ?? 10}`, "…and price turning up at/above this (of 20; 0 = not needed)"),
              pad(`PUMP_THIN=${st?.thin ?? "20-300"}`, "offers up to 2× ($): at/under the first = thin (full points)"),
              pad(`PUMP_SEESAW=${st?.seesaw ? "1" : "0"}`, "1 = seesaw mode (replaces auto-buy/Jev buys)"),
              pad(`PUMP_SEESAW_SCORE=${st?.seesawScore ?? 50}`, "seesaw: buy when a side's score reaches this"),
              pad(`PUMP_SEESAW_BET=${st?.seesawBet ?? 1}`, "seesaw: $ per buy (at least $1)"),
              pad(`PUMP_SEESAW_EVERY=${st?.seesawEvery ?? 15}`, "seesaw: re-buy every N s while the score stays up"),
              pad(`PUMP_SEESAW_MAX=${st?.seesawMax ?? 30}`, "seesaw: most buys per window"),
              pad(`PUMP_SEESAW_TP=${st?.seesawTp !== undefined ? Math.round(st.seesawTp * 100) : 3}`, "seesaw: sell a buy at +this % after fees (0 = off)"),
              pad(`PUMP_SEESAW_TARGET=${st?.seesawTarget !== undefined ? Math.round(st.seesawTarget * 100) : 5}`, "seesaw: window up this % in total → sell all, stop (0 = off)"),
              pad(`PUMP_SEESAW_JEV=${st?.seesawJev === false ? "0" : "1"}`, "seesaw: ask Jev to grade each buy (0 = off)"),
              pad(`PUMP_SEESAW_JEV_MIN=${st?.seesawJevMin !== undefined ? Math.round(st.seesawJevMin * 100) : 50}`, "seesaw: Jev's chance the bid reaches break-even needed (%)"),
              pad(`PUMP_ON=${st?.on === false ? "0" : "1"}`, "0 = off"),
            ].join("\n")}
          </pre>
          <p className="mt-2">
            Runs from its own cron job: every minute, POST to the fadebot function with body {`{"action":"pump"}`} and the
            managed cron authentication (the same as fadebot's cron).
          </p>
        </section>
      </div>
    </main>
  );
};

/** The recorder: what's been captured, and a CSV download of it. */
const Recorder = ({ s }: { s: PumpStatus | null | undefined }) => {
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState<string | null>(null);
  const rec = s?.recorder;
  const go = async () => {
    setBusy("starting…");
    try {
      const csv = await fetchPumpExport(hours, (d, t) => setBusy(`${d}/${t}`));
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `pump-recorder-${hours}h-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setBusy(null);
    } catch (e) {
      setBusy(`failed: ${(e as Error).message}`);
    }
  };
  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Recorder</h2>
          <p className="text-xs text-[#8b949e]">
            Every second, every side between 2¢ and 40¢: the book, real fill prices, BTC, Coinbase + perp order flow, and
            who won. {rec ? `Last 24 h: ${rec.rows24h.toLocaleString()} rows in ${rec.windows24h} windows, ${rec.settled24h.toLocaleString()} settled.` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <select
            className="rounded border border-[#30363d] bg-[#0e1116] px-2 py-1"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {[3, 6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>last {h} h</option>)}
          </select>
          <button
            className="rounded border border-[#30363d] px-3 py-1 hover:bg-[#21262d] disabled:opacity-50"
            disabled={!!busy && !busy.startsWith("failed")}
            onClick={go}
          >
            {busy && !busy.startsWith("failed") ? `Exporting ${busy}` : "Export CSV"}
          </button>
        </div>
      </div>
      {busy?.startsWith("failed") ? <p className="mt-1 text-xs text-[#ef5350]">{busy}</p> : null}
    </section>
  );
};

const PART_LABEL: Record<string, string> = {
  flow: "Buying pressure",
  thin: "Thin offers above",
  bids: "Bids stacking",
  turn: "Price turning up",
  btc: "BTC vol vs distance",
};

/** The bot's live read: the cheap side's score, each signal, and the top of its book. */
const LiveRead = ({ s }: { s: PumpStatus | null | undefined }) => {
  const lv = s?.live;
  const age = lv ? Math.round(Date.now() / 1000 - lv.at) : null;
  const min = s?.settings.minScore ?? 50;
  const sc = lv?.score;
  const book = lv?.features?.book;
  return (
    <section className={card}>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Live read</h2>
        <span className="text-xs text-[#8b949e]">
          {lv ? `${age} s ago${lv.seconds_left !== undefined ? ` · ${lv.seconds_left} s left in window` : ""}` : "no data yet"}
          {age !== null && age > 20 ? " (not running right now)" : ""}
        </span>
      </div>
      {!lv ? (
        <p className="text-xs text-[#8b949e]">Shows up once the bot runs.</p>
      ) : lv.holding ? (
        <p className="text-sm">
          Holding {lv.holding.side}: paid {c(lv.holding.paid)}, bid now {c(lv.holding.bid)}
        </p>
      ) : lv.note ? (
        <p className="text-sm text-[#8b949e]">Watching: {lv.note}.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums">{sc?.score ?? "—"}</span>
            <span className="text-sm text-[#8b949e]">
              / 100 for {lv.side} at {c(lv.ask)} (bid {lv.bid ?? "—"}¢) ·{" "}
              {sc && s?.settings.autoScore && sc.score >= s.settings.autoScore &&
                  (sc.parts.flow ?? 0) >= (s.settings.autoFlow ?? 15) && (sc.parts.turn ?? 0) >= (s.settings.autoTurn ?? 10)
                ? <span className="text-[#26a69a]">auto-buy level reached: buys without Jev</span>
                : sc && sc.score >= min
                ? <span className="text-[#26a69a]">at/above {min}: Jev gets asked</span>
                : `needs ${min} to ask Jev${
                  s?.settings.autoScore
                    ? `; ${s.settings.autoScore} + flow ${s.settings.autoFlow ?? 15} + turn ${s.settings.autoTurn ?? 10} to buy outright`
                    : ""
                }`}
            </span>
          </div>
          <div className="space-y-1">
            {Object.keys(PART_LABEL).filter((k) => sc?.parts?.[k] !== undefined).map((k) => [k, sc!.parts[k]] as const).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-xs">
                <span className="w-36 text-[#8b949e]">{PART_LABEL[k] ?? k}</span>
                <div className="h-2 flex-1 rounded bg-[#21262d]">
                  <div className="h-2 rounded bg-[#58a6ff]" style={{ width: `${(v / 20) * 100}%` }} />
                </div>
                <span className="w-10 text-right tabular-nums">{v}/20</span>
              </div>
            ))}
          </div>
          {sc?.notes?.length ? <p className="text-xs text-[#8b949e]">{sc.notes.join(" · ")}</p> : null}
          {lv.flip ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums sm:grid-cols-3">
              <span className="text-[#8b949e]">Fair chance (BTC): <b className="text-[#c9d1d9]">{lv.flip.fair === null ? "—" : `${(lv.flip.fair * 100).toFixed(1)}%`}</b></span>
              <span className="text-[#8b949e]">$10 fills at: <b className="text-[#c9d1d9]">{c(lv.flip.fill10)}</b></span>
              <span className="text-[#8b949e]">Fair − fill: <b className={tone(lv.flip.gap)}>{lv.flip.gap === null ? "—" : `${(lv.flip.gap * 100).toFixed(1)} pts`}</b></span>
              <span className="text-[#8b949e]">Coinbase OFI 5 s: <b className="text-[#c9d1d9]">{lv.flip.flow?.coinbase?.ofi_5s ?? "—"}</b></span>
              <span className="text-[#8b949e]">Coinbase net buys 5 s: <b className="text-[#c9d1d9]">{lv.flip.flow?.coinbase?.flow_5s?.net ?? "—"}</b></span>
              <span className="text-[#8b949e]">Perp net buys 5 s: <b className="text-[#c9d1d9]">{lv.flip.flow?.hyperliquid?.flow_5s?.net ?? "—"}</b></span>
            </div>
          ) : null}
          {book?.bids_top10 || book?.asks_top10 ? (
            <div className="grid grid-cols-2 gap-4 text-xs tabular-nums">
              <div>
                <div className="mb-1 text-[#8b949e]">Bids ({lv.side})</div>
                {(book.bids_top10 ?? []).slice(0, 6).map(([p, q], i) => (
                  <div key={i} className="flex justify-between text-[#26a69a]">
                    <span>{p}¢</span>
                    <span>{q}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="mb-1 text-[#8b949e]">Offers ({lv.side})</div>
                {(book.asks_top10 ?? []).slice(0, 6).map(([p, q], i) => (
                  <div key={i} className="flex justify-between text-[#ef5350]">
                    <span>{p}¢</span>
                    <span>{q}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
};

export default Pump;
