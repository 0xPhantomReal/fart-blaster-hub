import { useEffect, useState } from "react";
import { FadeBotPanel } from "@/gold/FadeBotPanel";
import { fadeBotStatus, type FadeBotStatus } from "@/gold/feed";

/** /bot — just the Polymarket bot: balance, today's result and the bot panel. No chart. */
const money = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `$${x.toFixed(2)}`;
const signed = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const tone = (x: number | null | undefined) =>
  x === null || x === undefined || x === 0 ? "text-[#c9d1d9]" : x > 0 ? "text-[#26a69a]" : "text-[#ef5350]";

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

        <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-4">
          <FadeBotPanel bars={[]} readSec={null} readLabel="" pastIsLive={false} status={s} botOnly />
        </section>
      </div>
    </main>
  );
};

export default Bot;
