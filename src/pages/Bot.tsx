import { useEffect, useState } from "react";
import { FadeBotPanel } from "@/gold/FadeBotPanel";
import { fadeBotStatus, type FadeBotStatus, fetchStatsReplay, type StatsReplay } from "@/gold/feed";

/** /bot — just the Polymarket bot: balance, today's result and the bot panel. No chart. */
const money = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `$${x.toFixed(2)}`;
const signed = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const tone = (x: number | null | undefined) =>
  x === null || x === undefined || x === 0 ? "text-[#c9d1d9]" : x > 0 ? "text-[#26a69a]" : "text-[#ef5350]";

/** Stats replay: the live bot's own stats-mode code and settings run over its stored asks, by day. */
const ReplayBox = ({ balance }: { balance: number | null | undefined }) => {
  const [days, setDays] = useState(7);
  const [gap, setGap] = useState(10);
  const [start, setStart] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<StatsReplay | null | undefined>(undefined);
  const [showTrades, setShowTrades] = useState(false);
  const run = async () => {
    setBusy(true);
    const b = Number(start) || (balance && balance > 0 ? Math.round(balance) : 100);
    setR(await fetchStatsReplay(days, gap, b));
    setBusy(false);
  };
  const tt = r?.totals;
  const time = (w: number) =>
    new Date(w * 1000).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const input = "w-16 rounded border border-[#30363d] bg-[#0e1116] px-2 py-1 text-sm tabular-nums";
  return (
    <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Stats replay</div>
          <div className="text-xs text-[#8b949e]">
            The bot's own stats-mode code and current settings, run over its stored calls. Can't replay the recheck.
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-xs text-[#8b949e]">
          <label className="flex flex-col gap-1">
            Days
            <input className={input} type="number" min={1} max={7} value={days}
              onChange={(e) => setDays(Math.min(7, Math.max(1, Number(e.target.value) || 7)))} />
          </label>
          <label className="flex flex-col gap-1">
            Gap ¢
            <input className={input} type="number" min={0} max={30} value={gap}
              onChange={(e) => setGap(Math.min(30, Math.max(0, Number(e.target.value) || 0)))} />
          </label>
          <label className="flex flex-col gap-1">
            Start $
            <input className={input + " w-20"} type="number" min={1} placeholder={balance ? String(Math.round(balance)) : "100"}
              value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <button
            className="rounded bg-[#238636] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? "Running…" : "Run replay"}
          </button>
        </div>
      </div>
      {r === null && <p className="mt-3 text-sm text-[#ef5350]">Replay failed (deploy the fadebot function first?).</p>}
      {r?.error && <p className="mt-3 text-sm text-[#ef5350]">{r.error}</p>}
      {r && tt && (
        <div className="mt-4 space-y-3 text-sm">
          {!r.settings.statsOn && (
            <p className="text-xs text-[#d29922]">Stats mode is off on the bot right now; this shows what it would do if on.</p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-xs text-[#8b949e]">Balance</div>
              <div className="tabular-nums font-medium">{money(tt.startBal)} → {money(tt.endBal)}</div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Trades / won</div>
              <div className="tabular-nums font-medium">
                {tt.trades} / {tt.won}{tt.trades ? ` (${Math.round((tt.won / tt.trades) * 100)}%)` : ""}
              </div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Worst drop</div>
              <div className="tabular-nums font-medium">{tt.worstDrop}%</div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Real bot, same days</div>
              <div className={`tabular-nums font-medium ${tone(tt.realPnl)}`}>
                {tt.realTrades} trades, {signed(tt.realPnl)}
              </div>
            </div>
          </div>
          <div className="text-xs text-[#8b949e]">
            {r.betPct}% of balance per trade, paid quote + {Math.round(r.gap * 100)}¢. Both traded {tt.bothTraded} windows;
            same side in {tt.sameSide}.
          </div>
          <table className="w-full text-xs tabular-nums">
            <thead className="text-[#8b949e]">
              <tr><th className="text-left">Day</th><th className="text-right">Trades</th><th className="text-right">Won</th>
                <th className="text-right">P&L</th><th className="text-right">End balance</th></tr>
            </thead>
            <tbody>
              {r.byDay.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td><td className="text-right">{d.trades}</td><td className="text-right">{d.won}</td>
                  <td className={`text-right ${tone(d.pnl)}`}>{signed(d.pnl)}</td>
                  <td className="text-right">{money(d.endBal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="text-xs text-[#58a6ff]" onClick={() => setShowTrades((x) => !x)}>
            {showTrades ? "Hide trades" : `Show trades (${r.trades.length})`}
          </button>
          {showTrades && (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-xs tabular-nums">
                <thead className="sticky top-0 bg-[#161b22] text-[#8b949e]">
                  <tr><th className="text-left">Window</th><th className="text-left">Jev</th><th className="text-left">Replay</th>
                    <th className="text-right">P&L</th><th className="text-left pl-2">Real bot</th></tr>
                </thead>
                <tbody>
                  {[...r.trades].reverse().map((x) => (
                    <tr key={x.window} title={x.note} className="border-t border-[#21262d]">
                      <td>{time(x.window)} <span className="text-[#8b949e]">{x.at}s</span></td>
                      <td>{x.jev} {x.pct}%</td>
                      <td>{x.side} {x.quote}¢→{x.paid}¢ {x.against ? "(against)" : ""}</td>
                      <td className={`text-right ${tone(x.pnl)}`}>{signed(x.pnl)}</td>
                      <td className="pl-2 text-[#8b949e]">
                        {x.real ? `${x.real.side} ${x.real.paid}¢ ${x.real.result ?? "open"}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

const Bot = () => {
  const [s, setS] = useState<FadeBotStatus | null | undefined>(undefined);
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    document.title = "Fadebot";
    let alive = true;
    const load = () =>
      fadeBotStatus().then((r) => {
        if (!alive) return;
        setS(r);
        setAt(new Date());
      });
    void load();
    const id = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const t = s?.trader ?? null;
  const live = !!t?.live;
  const open = t?.trades.find((x) => x.status === "open");
  const totals = t?.totals;
  const winRate = totals && totals.n ? Math.round((totals.wins / totals.n) * 100) : null;

  return (
    <main className="min-h-screen bg-[#0e1116] px-4 py-6 text-[#c9d1d9]">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">Fadebot</h1>
          <span className="text-xs text-[#8b949e]">
            {at ? `updated ${at.toLocaleTimeString()} · refreshes every 20 s` : "loading…"}
          </span>
        </header>

        {s === null ? (
          <p className="text-sm text-[#8b949e]">Can't reach the bot right now.</p>
        ) : (
          <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-[#8b949e]">
                  {live ? "Polymarket balance" : "Paper balance (test mode)"}
                </div>
                <div className="text-4xl font-semibold tabular-nums">{s === undefined ? "…" : money(t?.balance)}</div>
              </div>
              <span
                className={`rounded px-2 py-1 text-xs font-bold ${
                  live ? "bg-[#3d1d1d] text-[#ef5350]" : "bg-[#21262d] text-[#8b949e]"
                }`}
              >
                {live ? "LIVE" : "TEST"}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-[#8b949e]">Today</div>
                <div className={`tabular-nums font-medium ${tone(t?.today)}`}>{signed(t?.today)}</div>
              </div>
              <div>
                <div className="text-xs text-[#8b949e]">All-time</div>
                <div className={`tabular-nums font-medium ${tone(totals ? Number(totals.pnl) : null)}`}>
                  {totals ? signed(Number(totals.pnl)) : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#8b949e]">Trades / won</div>
                <div className="tabular-nums font-medium">
                  {totals ? `${totals.n} / ${totals.wins}${winRate !== null ? ` (${winRate}%)` : ""}` : "—"}
                </div>
              </div>
            </div>
            <div className="mt-3 text-xs text-[#8b949e]">
              {open
                ? `Holding ${open.side === "up" ? "Up" : "Down"}: ${money(Number(open.stake))} at ${Math.round(
                  Number(open.price) * 100,
                )}¢`
                : "No open position"}
            </div>
          </section>
        )}

        <ReplayBox balance={t?.balance} />

        <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-4">
          <FadeBotPanel bars={[]} readSec={null} readLabel="" pastIsLive={false} status={s} botOnly />
        </section>
      </div>
    </main>
  );
};

export default Bot;
