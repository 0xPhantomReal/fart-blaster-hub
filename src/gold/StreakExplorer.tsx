import { useMemo, useState } from "react";
import type { StatsReplayTrade } from "@/gold/feed";

/**
 * Streak explorer for the /bot replay: lists the losing (or winning) streaks, opens each one with the conditions
 * around every trade, and compares every condition across streak trades vs all trades so patterns stand out.
 * The conditions (trade.f) are measured at the moment of the buy by the bot's replay — no hindsight.
 */

type F = Record<string, number | string | boolean | null>;
type Feature = { key: string; label: string; bucket: (v: F[string], f: F) => string | null; order?: string[] };

const num = (v: F[string]) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const cut = (edges: number[], labels: string[]) => (v: F[string]) => {
  const x = num(v);
  if (x === null) return null;
  for (let i = 0; i < edges.length; i++) if (x < edges[i]) return labels[i];
  return labels[labels.length - 1];
};
const signed = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v)}`;

export const FEATURES: Feature[] = [
  { key: "score", label: "Confidence score (0–9)", bucket: cut([3, 5, 7, 8], ["0–2", "3–4", "5–6", "7", "8–9"]) },
  { key: "hour", label: "Time of day (ET)", bucket: cut([4, 8, 12, 16, 20], ["12–4 AM", "4–8 AM", "8 AM–12", "12–4 PM", "4–8 PM", "8 PM–12"]) },
  { key: "weekday", label: "Day of week", bucket: (v) => (v ? String(v) : null), order: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
  { key: "at", label: "Bought at (s into window)", bucket: cut([150, 170, 190, 220, 250], ["<150 s", "150–169 s", "170–189 s", "190–219 s", "220–249 s", "250 s+"]) },
  { key: "jevPct", label: "Jev %", bucket: cut([61, 71, 81, 91], ["50–60%", "61–70%", "71–80%", "81–90%", "91–100%"]) },
  { key: "withJev", label: "With / against Jev", bucket: (v) => (v === null ? null : v ? "with Jev" : "against Jev") },
  { key: "side", label: "Side bought", bucket: (v) => (v ? String(v) : null) },
  { key: "swapped", label: "Swapped", bucket: (v) => (v === null ? null : v ? "swapped" : "not swapped") },
  { key: "quote", label: "Quote", bucket: cut([10, 20, 30, 40, 50, 60, 70], ["<10¢", "10–19¢", "20–29¢", "30–39¢", "40–49¢", "50–59¢", "60–69¢", "70¢+"]) },
  { key: "quoteAge", label: "Quote age", bucket: cut([3, 6, 11, 21, 41], ["0–2 s", "3–5 s", "6–10 s", "11–20 s", "21–40 s", "41 s+"]) },
  { key: "staleMove", label: "BTC move while quote unchanged", bucket: cut([5, 15, 30, 60], ["<$5", "$5–14", "$15–29", "$30–59", "$60+"]) },
  { key: "distSide", label: "BTC vs start (toward side bought)", bucket: cut([-50, -25, 0, 25, 50], ["$50+ against", "$25–50 against", "$0–25 against", "$0–25 with", "$25–50 with", "$50+ with"]) },
  { key: "winRange", label: "BTC range in window so far", bucket: cut([25, 50, 100, 200], ["<$25", "$25–49", "$50–99", "$100–199", "$200+"]) },
  { key: "prev15", label: "BTC last 15 min (toward side)", bucket: cut([-100, -30, 30, 100], ["$100+ against", "$30–100 against", "flat (±$30)", "$30–100 with", "$100+ with"]) },
  { key: "prev60", label: "BTC last 60 min (toward side)", bucket: cut([-200, -60, 60, 200], ["$200+ against", "$60–200 against", "flat (±$60)", "$60–200 with", "$200+ with"]) },
  { key: "range30", label: "BTC range last 30 min (volatility)", bucket: cut([75, 150, 250, 400], ["<$75 (calm)", "$75–149", "$150–249", "$250–399", "$400+ (wild)"]) },
  { key: "last3With", label: "Last 3 windows that went the side's way", bucket: (v) => (num(v) === null ? null : `${v} of 3`) },
  { key: "run15", label: "15m candles in a row (+ with side, − against)", bucket: cut([-2, 0, 2], ["−2 or more", "−1", "+1", "+2 or more"]) },
  { key: "overround", label: "Up + Down − 100 (book spread)", bucket: cut([1, 3, 6], ["≤0¢", "1–2¢", "3–5¢", "6¢+"]) },
  { key: "confirmAt", label: "Confirmed at", bucket: cut([160, 170, 180, 190], ["<160 s", "160–169 s", "170–179 s", "180–189 s", "190 s+"]) },
  { key: "flips", label: "Bias flips", bucket: (v) => (num(v) === null ? null : Number(v) >= 2 ? "2+" : String(v)) },
  { key: "otherCalls", label: "Earlier calls on the other side", bucket: cut([1, 3, 6], ["0", "1–2", "3–5", "6+"]) },
  { key: "lossesBefore", label: "Losses in a row before this trade", bucket: (v) => (num(v) === null ? null : Number(v) >= 3 ? "3+" : String(v)) },
  { key: "minsSinceLast", label: "Minutes since last trade", bucket: cut([10, 30, 120, 480], ["<10", "10–29", "30–119", "120–479", "480+"]) },
  { key: "statsLevel", label: "Stats match level", bucket: (v) => (v ? String(v) : null) },
  { key: "statsN", label: "Stats past calls", bucket: cut([20, 40, 80], ["<20", "20–39", "40–79", "80+"]) },
  { key: "jevRight", label: "Stats: Jev right in history", bucket: cut([40, 50, 60, 75], ["<40%", "40–49%", "50–59%", "60–74%", "75%+"]) },
  { key: "expPer", label: "Stats' expected profit per $1", bucket: cut([20, 50, 100], ["<20¢", "20–49¢", "50–99¢", "100¢+"]) },
];

const keyOf = (t: StatsReplayTrade) => `${t.window}|${t.at}`;
const when = (w: number) =>
  new Date(w * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

type Row = { feature: string; bucket: string; n: number; won: number; pnl: number; inStreak: number; lift: number };

export type StreakKind = "loss" | "win";

export function analyse(trades: StatsReplayTrade[], minLen: number, kind: StreakKind = "loss") {
  const T = [...trades].sort((a, b) => a.window - b.window || a.at - b.at);
  const streaks: StatsReplayTrade[][] = [];
  let cur: StatsReplayTrade[] = [];
  for (const t of T) {
    if (t.won === (kind === "win")) cur.push(t);
    else {
      if (cur.length >= minLen) streaks.push(cur);
      cur = [];
    }
  }
  if (cur.length >= minLen) streaks.push(cur);
  const inS = new Set(streaks.flat().map(keyOf));
  const sTotal = inS.size;
  const rows: Row[] = [];
  for (const ft of FEATURES) {
    const by = new Map<string, { n: number; won: number; pnl: number; inStreak: number }>();
    for (const t of T) {
      const f = (t.f ?? {}) as F;
      const b = ft.bucket(f[ft.key] ?? null, f);
      if (b === null) continue;
      const x = by.get(b) ?? { n: 0, won: 0, pnl: 0, inStreak: 0 };
      x.n++;
      if (t.won) x.won++;
      x.pnl += t.pnl;
      if (inS.has(keyOf(t))) x.inStreak++;
      by.set(b, x);
    }
    for (const [b, x] of by) {
      const lift = sTotal && T.length ? (x.inStreak / sTotal) / (x.n / T.length) : 0;
      rows.push({ feature: ft.label, bucket: b, ...x, lift });
    }
  }
  return { T, streaks, inS, rows };
}

function toCsv(T: StatsReplayTrade[], inS: Set<string>) {
  const keys = FEATURES.map((f) => f.key);
  const head = ["window_et", "window", "at", "side", "quote", "paid", "won", "pnl", "in_streak", ...keys];
  const esc = (v: unknown) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = T.map((t) => {
    const f = (t.f ?? {}) as F;
    return [when(t.window), t.window, Math.round(t.at), t.side, t.quote, t.paid, t.won, t.pnl, inS.has(keyOf(t)), ...keys.map((k) => f[k])]
      .map(esc)
      .join(",");
  });
  return [head.join(","), ...lines].join("\n");
}

export function StreakExplorer({ trades, initialKind = "loss" }: { trades: StatsReplayTrade[]; initialKind?: StreakKind }) {
  const [kind, setKind] = useState<StreakKind>(initialKind);
  const [minLen, setMinLen] = useState(3);
  const [open, setOpen] = useState<number | null>(null);
  const [feature, setFeature] = useState<string>("");
  const { T, streaks, inS, rows } = useMemo(() => analyse(trades, minLen, kind), [trades, minLen, kind]);
  const win = kind === "win";
  const word = win ? "wins" : "losses";
  const longest = useMemo(() => {
    const out = { loss: 0, win: 0 };
    let run = 0, last: boolean | null = null;
    for (const t of [...trades].sort((a, b) => a.window - b.window || a.at - b.at)) {
      run = t.won === last ? run + 1 : 1;
      last = t.won;
      if (t.won) out.win = Math.max(out.win, run);
      else out.loss = Math.max(out.loss, run);
    }
    return out;
  }, [trades]);
  // over-represented in this kind of streak: red for losing streaks, green for winning ones
  const hot = win ? "text-[#26a69a]" : "text-[#ef5350]";
  const cold = win ? "text-[#ef5350]" : "text-[#26a69a]";
  const hasF = T.some((t) => t.f);
  const signals = rows.filter((r) => r.n >= 4 && r.inStreak >= 2).sort((a, b) => b.lift - a.lift).slice(0, 12);
  const worst = rows.filter((r) => r.n >= 4).sort((a, b) => a.pnl - b.pnl).slice(0, 10);
  const best = rows.filter((r) => r.n >= 4).sort((a, b) => b.pnl - a.pnl).slice(0, 8);
  const shown = feature ? rows.filter((r) => r.feature === feature) : [];
  const ftOrder = FEATURES.find((f) => f.label === feature)?.order;
  if (ftOrder) shown.sort((a, b) => ftOrder.indexOf(a.bucket) - ftOrder.indexOf(b.bucket));
  const download = () => {
    const blob = new Blob([toCsv(T, inS)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `replay-trades-with-conditions-${win ? "win" : "loss"}-streaks.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const table = (R: Row[], showFeature = true) => (
    <table className="w-full text-xs tabular-nums">
      <thead className="text-[#8b949e]">
        <tr>
          {showFeature && <th className="text-left">Condition</th>}
          <th className="text-left">Value</th>
          <th className="text-right">Trades</th>
          <th className="text-right">Won</th>
          <th className="text-right">P&L</th>
          <th className="text-right" title={`Trades in this group that were part of a ${win ? "winning" : "losing"} streak`}>
            In streaks
          </th>
          <th className="text-right" title="How much more common this is in streak trades than in all trades (1.0 = no difference)">Lift</th>
        </tr>
      </thead>
      <tbody>
        {R.map((r) => (
          <tr key={r.feature + r.bucket} className={`border-t border-[#21262d] ${r.n < 4 ? "opacity-50" : ""}`}>
            {showFeature && <td className="pr-2">{r.feature}</td>}
            <td className="pr-2">{r.bucket}</td>
            <td className="text-right">{r.n}</td>
            <td className="text-right">{Math.round((r.won / r.n) * 100)}%</td>
            <td className={`text-right ${r.pnl >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}`}>{signed(Math.round(r.pnl))}</td>
            <td className="text-right">{r.inStreak}</td>
            <td className={`text-right ${r.lift >= 1.5 ? hot : r.lift <= 0.5 && r.n >= 4 ? cold : ""}`}>
              {r.lift.toFixed(1)}×
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className="space-y-4 rounded border border-[#30363d] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(["loss", "win"] as const).map((k) => (
            <button
              key={k}
              className={`rounded px-2 py-1 text-xs font-semibold ${
                kind === k ? (k === "win" ? "bg-[#238636] text-white" : "bg-[#da3633] text-white") : "border border-[#30363d] text-[#8b949e]"
              }`}
              onClick={() => {
                setKind(k);
                setOpen(null);
              }}
            >
              {k === "win" ? `Winning streaks (best ${longest.win})` : `Losing streaks (worst ${longest.loss})`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-[#8b949e]">
          Streak = at least
          <select
            className="rounded border border-[#30363d] bg-[#0e1116] px-1 py-0.5 text-[#c9d1d9]"
            value={minLen}
            onChange={(e) => {
              setMinLen(Number(e.target.value));
              setOpen(null);
            }}
          >
            {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {word} in a row
          <button className="text-[#58a6ff]" onClick={download}>Download CSV</button>
        </div>
      </div>
      {!hasF && (
        <p className="text-xs text-[#d29922]">These results have no trade conditions: deploy the latest fadebot and run the replay again.</p>
      )}
      <div className="space-y-1">
        <div className="text-xs text-[#8b949e]">
          {streaks.length} streak{streaks.length === 1 ? "" : "s"} of {minLen}+ {word} ({inS.size} of {T.length} trades). Tap one to
          see every trade in it.
        </div>
        {streaks.map((s, i) => {
          const pnl = s.reduce((x, t) => x + t.pnl, 0);
          return (
            <div key={i} className="rounded bg-[#0e1116]">
              <button className="flex w-full justify-between px-2 py-1.5 text-left text-xs" onClick={() => setOpen(open === i ? null : i)}>
                <span>
                  {when(s[0].window)} → {when(s[s.length - 1].window)} · <b>{s.length} {word}</b>
                </span>
                <span className={pnl >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}>{signed(Math.round(pnl))}</span>
              </button>
              {open === i && (
                <div className="overflow-auto px-2 pb-2">
                  <table className="w-full whitespace-nowrap text-[11px] tabular-nums">
                    <thead className="text-[#8b949e]">
                      <tr>
                        <th className="pr-2 text-left">Window</th><th className="pr-2 text-left">Bought</th><th className="pr-2">Jev</th>
                        <th className="pr-2">Quote age</th><th className="pr-2">BTC moved (stale)</th><th className="pr-2">BTC vs start</th>
                        <th className="pr-2">15 min</th><th className="pr-2">30-min range</th><th className="pr-2">Last 3 wins</th>
                        <th className="pr-2">15m run</th><th className="pr-2">Confirmed</th><th className="pr-2">Stats</th><th>P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.map((t) => {
                        const f = (t.f ?? {}) as F;
                        const $ = (v: F[string]) => (num(v) === null ? "—" : signed(Number(v)));
                        return (
                          <tr key={keyOf(t)} className="border-t border-[#21262d]">
                            <td className="pr-2">{when(t.window)} {Math.round(t.at)}s</td>
                            <td className="pr-2">{t.side} {t.quote}¢{f.swapped ? " (swap)" : ""}</td>
                            <td className="pr-2">{f.jevPct ?? "—"}% {f.withJev ? "with" : "against"}</td>
                            <td className="pr-2">{f.quoteAge ?? "—"} s</td>
                            <td className="pr-2">{num(f.staleMove) === null ? "—" : `$${f.staleMove}`}</td>
                            <td className="pr-2">{$(f.distSide)}</td>
                            <td className="pr-2">{$(f.prev15)}</td>
                            <td className="pr-2">{num(f.range30) === null ? "—" : `$${f.range30}`}</td>
                            <td className="pr-2">{f.last3With ?? "—"}/3</td>
                            <td className="pr-2">{f.run15 ?? "—"}</td>
                            <td className="pr-2">{f.confirmAt ?? "—"} s</td>
                            <td className="pr-2">{f.jevRight ?? "—"}% of {f.statsN ?? "—"}, {f.expPer ?? "—"}¢</td>
                            <td className={t.pnl >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}>{signed(Math.round(t.pnl))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {hasF && T.length > 0 && (
        <>
          <div>
            <div className="mb-1 text-xs font-semibold text-[#8b949e]">
              Most over-represented in {win ? "winning" : "losing"} streaks (lift)
            </div>
            {signals.length ? table(signals) : <p className="text-xs text-[#8b949e]">No condition shows up in 2+ streak trades yet.</p>}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-semibold text-[#8b949e]">Worst conditions by P&L</div>
              {table(worst)}
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold text-[#8b949e]">Best conditions by P&L</div>
              {table(best)}
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs text-[#8b949e]">
              Look at one condition:
              <select
                className="rounded border border-[#30363d] bg-[#0e1116] px-1 py-0.5 text-[#c9d1d9]"
                value={feature}
                onChange={(e) => setFeature(e.target.value)}
              >
                <option value="">choose…</option>
                {FEATURES.map((f) => <option key={f.key} value={f.label}>{f.label}</option>)}
              </select>
            </div>
            {feature && table(shown, false)}
          </div>
          <p className="text-[11px] text-[#8b949e]">
            Lift 2.0× = twice as common in {win ? "winning" : "losing"}-streak trades as overall. Faded rows have under 4 trades. With this few trades,
            many "patterns" are chance: check that a pattern holds on a different week (another replay or export) before
            turning it into a rule. Dollar moves are signed toward the side bought (+ = BTC moving its way).
          </p>
        </>
      )}
    </div>
  );
}
