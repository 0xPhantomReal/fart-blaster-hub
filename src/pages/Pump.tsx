import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPumpStatus, type PumpStatus } from "@/gold/feed";

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
  const tot = s?.totals.find((t) => t.mode === s.mode);
  const open = s?.trades.find((t) => t.status === "open");
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
                {st
                  ? `Scores every cheap side (under ${st.maxAsk}¢) from the live book, trades and BTC. At ${st.minScore ?? 50}+ it asks Jev ` +
                    `and buys $${st.bet} if Jev gives ${st.minProb}%+ to pump ${st.tp}%` +
                    `${st.autoScore ? `; at ${st.autoScore}+ it buys without asking` : ""}. ` +
                    `Sells at +${st.tp}%, −${st.sl}%, or with ${st.exitSec} s left.`
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
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
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
                <div className="text-xs text-[#8b949e]">+100% / −50% / time</div>
                <div className="tabular-nums font-medium">{tot ? `${tot.tp} / ${tot.sl} / ${tot.timed}` : "—"}</div>
              </div>
            </div>
            <div className="mt-3 text-xs text-[#8b949e]">
              {open
                ? `Holding ${open.side === "up" ? "Up" : "Down"}: ${open.shares.toFixed(2)} @ ${c(open.price)} — sells at ${c(
                  open.price * (1 + (st?.tp ?? 100) / 100),
                )} or ${c(open.price * (1 - (st?.sl ?? 50) / 100))}`
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
                    <td>{t.side}</td>
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
              pad(`PUMP_BET=${st?.bet ?? 1}`, "$ per trade"),
              pad(`PUMP_MAX_ASK=${st?.maxAsk ?? 30}`, "buy only under this (¢)"),
              pad(`PUMP_MIN_ASK=${st?.minAsk ?? 2}`, "…and at least this (¢)"),
              pad(`PUMP_TP=${st?.tp ?? 100}`, "take profit, % of price paid (on the bid)"),
              pad(`PUMP_SL=${st?.sl ?? 50}`, "stop loss, %"),
              pad(`PUMP_EXIT_SEC=${st?.exitSec ?? 10}`, "sell with this many seconds left"),
              pad(`PUMP_MIN_LEFT=${st?.minLeft ?? 45}`, "no buys with fewer seconds left"),
              pad(`PUMP_JEV_EVERY=${st?.jevEvery ?? 5}`, "ask Jev every N s while a side is cheap"),
              pad(`PUMP_MIN_PROB=${st?.minProb ?? 40}`, "Jev's pump chance needed to buy (%)"),
              pad(`PUMP_SLIP=${st?.slip ?? 2}`, "skip if the ask rose more than this (¢) while Jev thought"),
              pad(`PUMP_MAX_TRADES=${st?.maxTrades ?? 1}`, "buys per window"),
              pad(`PUMP_DAILY_LOSS=${st?.dailyLoss ?? 20}`, "stop buying for the day after losing this ($)"),
              pad(`PUMP_MIN_SCORE=${st?.minScore ?? 50}`, "microstructure score (0–100) needed before Jev is asked"),
              pad(`PUMP_AUTO_SCORE=${st?.autoScore ?? 60}`, "at/above this score: buy without asking Jev (0 = off)"),
              pad(`PUMP_THIN=${st?.thin ?? "20-300"}`, "offers up to 2× ($): at/under the first = thin (full points)"),
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
              {sc && s?.settings.autoScore && sc.score >= s.settings.autoScore
                ? <span className="text-[#26a69a]">at/above {s.settings.autoScore}: buys without Jev</span>
                : sc && sc.score >= min
                ? <span className="text-[#26a69a]">at/above {min}: Jev gets asked</span>
                : `needs ${min} to ask Jev${s?.settings.autoScore ? `, ${s.settings.autoScore} to buy outright` : ""}`}
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
