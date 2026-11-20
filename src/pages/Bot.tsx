import { useEffect, useState } from "react";
import { FadeBotPanel } from "@/gold/FadeBotPanel";
import { fadeBotStatus, type FadeBotStatus, fetchReplay, type StatsReplay } from "@/gold/feed";
import { parsePaste, type PasteResult, pasteReference, toPaste } from "@/gold/replayPaste";

/** /bot — just the Polymarket bot: balance, today's result and the bot panel. No chart. */
const money = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `$${x.toFixed(2)}`;
const signed = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const tone = (x: number | null | undefined) =>
  x === null || x === undefined || x === 0 ? "text-[#c9d1d9]" : x > 0 ? "text-[#26a69a]" : "text-[#ef5350]";

type Field = { key: string; label: string; hint: string; kind?: "onoff" | "choice"; choices?: [string, string][] };
const FIELDS: { group: string; fields: Field[] }[] = [
  {
    group: "Calls",
    fields: [
      { key: "edge", label: "Edge (pts)", hint: "FADEBOT_TRADER_EDGE" },
      { key: "minSec", label: "No calls before (s)", hint: "FADEBOT_TRADER_MIN_SEC" },
      { key: "confirmSec", label: "Confirm after (s, 0 = off)", hint: "FADEBOT_TRADER_CONFIRM_SEC" },
      { key: "confirm2Sec", label: "Warm → buy wait (s, 0 = off; replay only)", hint: "replay only: triple confirmation" },
      { key: "confirmAt", label: "Confirmed at (s, e.g. 160-189)", hint: "FADEBOT_TRADER_CONFIRM_AT" },
      {
        key: "confirmAtMode",
        label: "Confirmed too early",
        hint: "FADEBOT_TRADER_CONFIRM_AT_MODE",
        kind: "choice",
        choices: [["reask", "Ask again"], ["skip", "Skip the window"]],
      },
      {
        key: "ageRules",
        label: "Quote-age rules (e.g. 0-2:none;3-5:50-99;21+:all)",
        hint: "FADEBOT_TRADER_AGE_RULES",
      },
      { key: "streak15", label: "No trades after 15m streak of (0 = off)", hint: "FADEBOT_TRADER_STREAK15" },
      { key: "skipJevPct", label: "Skip Jev % (e.g. 50-55,61-70)", hint: "FADEBOT_TRADER_SKIP_JEV_PCT" },
    ],
  },
  {
    group: "Price rules (stats off)",
    fields: [
      { key: "invert", label: "Invert", hint: "FADEBOT_TRADER_INVERT", kind: "onoff" },
      { key: "ban", label: "Ban Jev's side (e.g. 51-99, blank = off)", hint: "FADEBOT_TRADER_BAN" },
      { key: "skipRanges", label: "Skip prices (e.g. 49-62)", hint: "FADEBOT_TRADER_SKIP_RANGES" },
      { key: "skipReask", label: "Skip re-asks", hint: "FADEBOT_TRADER_SKIP_REASK", kind: "onoff" },
      { key: "swapRanges", label: "Swap prices (blank = no swap)", hint: "FADEBOT_TRADER_SWAP_RANGES" },
    ],
  },
  {
    group: "Stats mode",
    fields: [
      { key: "stats", label: "Stats", hint: "FADEBOT_TRADER_STATS", kind: "onoff" },
      { key: "statsMinEdge", label: "Min edge (¢ per $1)", hint: "FADEBOT_TRADER_STATS_MIN_EDGE" },
      { key: "statsInvert", label: "Stats invert", hint: "FADEBOT_TRADER_STATS_INVERT", kind: "onoff" },
      { key: "statsSwapAbove", label: "Swap above (¢, 0 = off)", hint: "FADEBOT_TRADER_STATS_SWAP_ABOVE" },
      { key: "statsSwapRanges", label: "Stats swap prices (e.g. 60-99,41-43)", hint: "FADEBOT_TRADER_STATS_SWAP_RANGES" },
      { key: "statsSkipRanges", label: "Stats skip prices (e.g. 30-39)", hint: "FADEBOT_TRADER_STATS_SKIP_RANGES" },
      { key: "statsMaxAgainst", label: "Wrong-side skip ($, 0 = off)", hint: "FADEBOT_TRADER_STATS_MAX_AGAINST" },
      { key: "statsMinN", label: "Min past calls", hint: "FADEBOT_TRADER_STATS_MIN_N" },
      { key: "statsSlip", label: "Slip (¢)", hint: "FADEBOT_TRADER_STATS_SLIP" },
      { key: "statsCandles", label: "History (windows)", hint: "FADEBOT_TRADER_STATS_CANDLES" },
    ],
  },
  {
    group: "Fills & exits (replay only)",
    fields: [
      { key: "maxFill", label: "Max fill price (¢, 0 = off)", hint: "replay only: buys that would fill above this ask again" },
      { key: "tpPct", label: "Take profit (% of price paid, 0 = off)", hint: "replay only" },
      { key: "slPct", label: "Stop loss (% of price paid, 0 = off)", hint: "replay only" },
      { key: "maxEntries", label: "Max entries per window (after a sell)", hint: "FADEBOT_TRADER_MAX_ENTRIES" },
    ],
  },
  {
    group: "Sizing",
    fields: [
      {
        key: "sizing",
        label: "Sizing (replay only)",
        hint: "replay only",
        kind: "choice",
        choices: [["pct", "Bet % of balance"], ["martingale", "Martingale"], ["fibonacci", "Fibonacci"]],
      },
      { key: "betPct", label: "Bet % of balance", hint: "FADEBOT_TRADER_BET_PCT" },
      { key: "baseBet", label: "Base bet ($, blank = bet % of start)", hint: "replay only: martingale / fibonacci" },
      { key: "mgMult", label: "Martingale × after a loss", hint: "replay only" },
      { key: "resetAfter", label: "Reset after losses in a row (0 = never)", hint: "replay only" },
      { key: "dailyLoss", label: "Daily loss limit ($)", hint: "FADEBOT_TRADER_DAILY_LOSS" },
    ],
  },
];

type TraderSettings = NonNullable<FadeBotStatus["settings"]["trader"]>;
const rng = (x?: { lo: number; hi: number }[]) =>
  (x ?? []).map((r) => `${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}`).join(",");
const c100 = (x?: number) => (x === undefined || x === null ? "" : String(Math.round(x * 100)));
/** The live settings as form values. */
function fromLive(t: TraderSettings): Record<string, string> {
  const yn = (b?: boolean) => (b ? "on" : "off");
  return {
    edge: c100(t.edge),
    minSec: String(t.minSec ?? 0),
    confirmSec: String(t.confirmSec ?? 0),
    confirm2Sec: "0",
    confirmAt: t.confirmAt ? `${t.confirmAt.lo}-${t.confirmAt.hi}` : "",
    confirmAtMode: t.confirmAtReask ? "reask" : "skip",
    ageRules: (t.ageRules ?? [])
      .map((r) =>
        `${r.lo}${r.hi === null || r.hi === undefined || r.hi > 1e6 ? "+" : `-${r.hi}`}:${
          r.allow === null ? "all" : r.allow.length ? rng(r.allow) : "none"
        }`
      )
      .join(";"),
    streak15: String(t.streak15 ?? 0),
    skipJevPct: rng(t.skipJevPct),
    invert: yn(t.invert),
    ban: t.banLo !== undefined && t.banHi !== undefined ? rng([{ lo: t.banLo, hi: t.banHi }]) : "",
    skipRanges: rng(t.skipRanges),
    skipReask: yn(t.skipReask),
    swapRanges: t.swap === false ? "" : rng(t.swapRanges),
    stats: yn(t.stats),
    statsMinEdge: c100(t.statsMinEdge),
    statsInvert: yn(t.statsInvert),
    statsSwapAbove: c100(t.statsSwapAbove ?? 0),
    statsSwapRanges: rng(t.statsSwapRanges),
    statsSkipRanges: rng(t.statsSkipRanges),
    statsMaxAgainst: String(t.statsMaxAgainst ?? 0),
    statsMinN: String(t.statsMinN ?? 15),
    statsSlip: c100(t.statsSlip),
    statsCandles: String(t.statsCandles ?? 288),
    betPct: String(t.betPct ?? 5),
    sizing: "pct",
    baseBet: "",
    mgMult: "2",
    resetAfter: "0",
    maxFill: "0",
    tpPct: "0",
    slPct: "0",
    maxEntries: String((t as { maxEntries?: number }).maxEntries ?? 3),
    dailyLoss: String(t.dailyLoss ?? ""),
  };
}
/** The form as the replay takes it: blank ranges mean "none", and no swap ranges means swap off. */
function toReplay(f: Record<string, string>): Record<string, string> {
  return { ...f, swap: f.swapRanges.trim() ? "on" : "off" };
}
/** The secrets that would run these settings live. */
function secretsFor(f: Record<string, string>): string[] {
  const out: string[] = [];
  const put = (k: string, v: string) => out.push(`${k}=${v}`);
  put("FADEBOT_TRADER_ORDER", "market");
  put("FADEBOT_TRADER_EDGE", f.edge);
  put("FADEBOT_TRADER_MIN_SEC", f.minSec || "0");
  put("FADEBOT_TRADER_CONFIRM_SEC", f.confirmSec || "0");
  put("FADEBOT_TRADER_CONFIRM_AT", f.confirmAt || "(delete)");
  if (f.confirmAt) put("FADEBOT_TRADER_CONFIRM_AT_MODE", f.confirmAtMode === "reask" ? "reask" : "(delete)");
  put("FADEBOT_TRADER_AGE_RULES", f.ageRules || "(delete)");
  put("FADEBOT_TRADER_STREAK15", f.streak15 || "0");
  put("FADEBOT_TRADER_SKIP_JEV_PCT", f.skipJevPct || "(delete)");
  put("FADEBOT_TRADER_STATS", f.stats === "on" ? "on" : "off");
  if (f.stats === "on") {
    put("FADEBOT_TRADER_STATS_MIN_EDGE", f.statsMinEdge);
    put("FADEBOT_TRADER_STATS_INVERT", f.statsInvert === "on" ? "1" : "0");
    put("FADEBOT_TRADER_STATS_SWAP_ABOVE", f.statsSwapAbove || "0");
    put("FADEBOT_TRADER_STATS_SWAP_RANGES", f.statsSwapRanges || "(delete)");
    put("FADEBOT_TRADER_STATS_SKIP_RANGES", f.statsSkipRanges || "(delete)");
    put("FADEBOT_TRADER_STATS_MAX_AGAINST", f.statsMaxAgainst || "0");
    put("FADEBOT_TRADER_STATS_MIN_N", f.statsMinN);
    put("FADEBOT_TRADER_STATS_SLIP", f.statsSlip);
    put("FADEBOT_TRADER_STATS_CANDLES", f.statsCandles);
  } else {
    put("FADEBOT_TRADER_INVERT", f.invert === "on" ? "1" : "0");
    const ban = f.ban.trim().match(/^(\d+)\s*-\s*(\d+)/);
    if (ban) {
      put("FADEBOT_TRADER_BAN", "on");
      put("FADEBOT_TRADER_BAN_MIN", ban[1]);
      put("FADEBOT_TRADER_BAN_MAX", ban[2]);
    } else put("FADEBOT_TRADER_BAN", "off");
    put("FADEBOT_TRADER_SKIP_RANGES", f.skipRanges || "(delete)");
    put("FADEBOT_TRADER_SKIP_REASK", f.skipReask === "on" ? "on" : "off");
    if (f.swapRanges.trim()) {
      put("FADEBOT_TRADER_SWAP", "on");
      put("FADEBOT_TRADER_SWAP_RANGES", f.swapRanges);
    } else put("FADEBOT_TRADER_SWAP", "off");
  }
  put("FADEBOT_TRADER_BET_PCT", f.betPct);
  if (f.dailyLoss) put("FADEBOT_TRADER_DAILY_LOSS", f.dailyLoss);
  return out;
}

/** Replay: the live bot's own market-buy code run over its stored calls, with settings you can change. */
const ReplayBox = ({ live, balance }: { live: TraderSettings | undefined; balance: number | null | undefined }) => {
  const [days, setDays] = useState(7);
  const [gap, setGap] = useState(10);
  const [start, setStart] = useState<string>("");
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<StatsReplay | null | undefined>(undefined);
  const [showTrades, setShowTrades] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasted, setPasted] = useState<PasteResult | null>(null);
  const [copied, setCopied] = useState("");
  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(what), () => setCopied(""));
  };
  const applyPaste = () => {
    if (!form) return;
    const res = parsePaste(pasteText, form);
    setForm(res.form);
    if (res.controls.days !== undefined) setDays(res.controls.days);
    if (res.controls.gap !== undefined) setGap(res.controls.gap);
    if (res.controls.start !== undefined) setStart(String(res.controls.start));
    setPasted(res);
  };
  useEffect(() => {
    if (live && !form) setForm(fromLive(live));
  }, [live, form]);
  const run = async () => {
    if (!form) return;
    setBusy(true);
    const b = Number(start) || (balance && balance > 0 ? Math.round(balance) : 100);
    setR(await fetchReplay(days, gap, b, toReplay(form)));
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
  const statsOn = form?.stats === "on";
  return (
    <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-4">
      <div className="text-sm font-semibold">Replay</div>
      <div className="text-xs text-[#8b949e]">
        The bot's own market-buy code run over its stored calls with these settings (they start as your live ones;
        changing them here changes nothing on the bot). Not replayed: the recheck's second price; fills are the quote +
        the gap.
      </div>
      {!form ? (
        <p className="mt-3 text-sm text-[#8b949e]">Loading your settings…</p>
      ) : (
        <div className="mt-3 space-y-3">
          {FIELDS.map((g) => (
            <fieldset
              key={g.group}
              className={`rounded border border-[#30363d] p-2 ${
                (g.group.startsWith("Price") && statsOn)
                  ? "opacity-50"
                  : ""
              }`}
            >
              <legend className="px-1 text-xs text-[#8b949e]">
                {g.group}
                {g.group.startsWith("Price") && statsOn ? " — ignored while stats is on" : ""}
              </legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {g.fields.map((fl) => (
                  <label key={fl.key} className="flex flex-col gap-1 text-xs text-[#8b949e]" title={fl.hint}>
                    {fl.label}
                    {fl.kind === "choice" ? (
                      <select
                        className="rounded border border-[#30363d] bg-[#0e1116] px-2 py-1 text-sm text-[#c9d1d9]"
                        value={form[fl.key]}
                        onChange={(e) => setForm({ ...form, [fl.key]: e.target.value })}
                      >
                        {(fl.choices ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    ) : fl.kind === "onoff" ? (
                      <select
                        className="rounded border border-[#30363d] bg-[#0e1116] px-2 py-1 text-sm text-[#c9d1d9]"
                        value={form[fl.key]}
                        onChange={(e) => setForm({ ...form, [fl.key]: e.target.value })}
                      >
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                    ) : (
                      <input
                        className="rounded border border-[#30363d] bg-[#0e1116] px-2 py-1 text-sm tabular-nums text-[#c9d1d9]"
                        value={form[fl.key]}
                        onChange={(e) => setForm({ ...form, [fl.key]: e.target.value })}
                      />
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
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
              <input className={input + " w-20"} type="number" min={1}
                placeholder={balance ? String(Math.round(balance)) : "100"} value={start}
                onChange={(e) => setStart(e.target.value)} />
            </label>
            <button
              className="rounded bg-[#238636] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void run()}
            >
              {busy ? "Running…" : "Run replay"}
            </button>
            <button className="rounded border border-[#30363d] px-3 py-1.5 text-sm" onClick={() => live && setForm(fromLive(live))}>
              Reset to live
            </button>
            <button
              className="rounded border border-[#30363d] px-3 py-1.5 text-sm"
              onClick={() => {
                setPasted(null);
                setCopied("");
                setShowPaste(true);
              }}
            >
              Paste settings
            </button>
            <button className="text-xs text-[#58a6ff]" onClick={() => setShowSecrets((x) => !x)}>
              {showSecrets ? "Hide secrets" : "Secrets for these settings"}
            </button>
          </div>
          {showSecrets && (
            <pre className="overflow-auto rounded bg-[#0e1116] p-2 text-xs">{secretsFor(form).join("\n")}</pre>
          )}
          {showPaste && (
            <div
              className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-3 sm:p-8"
              onClick={() => setShowPaste(false)}
            >
              <div
                className="w-full max-w-2xl space-y-3 rounded-lg border border-[#30363d] bg-[#161b22] p-4 text-sm"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold">Paste settings</div>
                  <button className="text-[#8b949e]" onClick={() => setShowPaste(false)} aria-label="Close">✕</button>
                </div>
                <p className="text-xs text-[#8b949e]">
                  One setting per line, e.g. <code>EDGE=20</code> or <code>FADEBOT_TRADER_STATS_MIN_EDGE=5</code>. Any
                  order. Settings you leave out keep their current value.
                </p>
                <textarea
                  className="h-44 w-full rounded border border-[#30363d] bg-[#0e1116] p-2 font-mono text-xs text-[#c9d1d9]"
                  placeholder={"EDGE=20\nCONFIRM_SEC=120\nCONFIRM_AT=160-189\nSTATS=on\nDAYS=7\nGAP=10"}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    className="rounded bg-[#238636] px-3 py-1.5 font-medium text-white disabled:opacity-50"
                    disabled={!pasteText.trim()}
                    onClick={applyPaste}
                  >
                    Apply to the form
                  </button>
                  <button
                    className="rounded border border-[#30363d] px-3 py-1.5"
                    onClick={() => form && copy("current", toPaste(form, { days, gap, start: Number(start) || undefined }))}
                  >
                    {copied === "current" ? "Copied ✓" : "Copy current settings"}
                  </button>
                  <button className="rounded border border-[#30363d] px-3 py-1.5" onClick={() => setShowPaste(false)}>
                    Close
                  </button>
                </div>
                {pasted && (
                  <div className="space-y-1 rounded bg-[#0e1116] p-2 text-xs">
                    <div className="text-[#26a69a]">
                      Applied {pasted.applied.length}: {pasted.applied.join(" · ") || "nothing"}
                    </div>
                    {pasted.ignored.length > 0 && (
                      <div className="text-[#d29922]">Not recognised (ignored): {pasted.ignored.join(" · ")}</div>
                    )}
                    <div className="text-[#8b949e]">Check the form, then press Run replay.</div>
                  </div>
                )}
                <div className="border-t border-[#30363d] pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs font-semibold text-[#8b949e]">Format and every setting (for other agents)</div>
                    <button className="text-xs text-[#58a6ff]" onClick={() => copy("format", pasteReference())}>
                      {copied === "format" ? "Copied ✓" : "Copy format"}
                    </button>
                  </div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[#0e1116] p-2 text-[11px] leading-snug text-[#c9d1d9]">
                    {pasteReference()}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {r === null && <p className="mt-3 text-sm text-[#ef5350]">Replay failed (deploy the fadebot function first?).</p>}
      {r?.error && <p className="mt-3 text-sm text-[#ef5350]">{r.error}</p>}
      {r && tt && (
        <div className="mt-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-xs text-[#8b949e]">Balance</div>
              <div className={`tabular-nums font-medium ${tone(tt.endBal - tt.startBal)}`}>
                {money(tt.startBal)} → {money(tt.endBal)}
              </div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Trades / won</div>
              <div className="tabular-nums font-medium">
                {tt.trades} / {tt.won}{tt.trades ? ` (${Math.round((tt.won / tt.trades) * 100)}%)` : ""}
              </div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Worst drop / losing streak</div>
              <div className="tabular-nums font-medium">{tt.worstDrop}% / {tt.worstStreak}</div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Real bot, same days</div>
              <div className={`tabular-nums font-medium ${tone(tt.realPnl)}`}>
                {tt.realTrades} trades, {signed(tt.realPnl)}
              </div>
            </div>
          </div>
          <div className="text-xs text-[#8b949e]">
            {r.used?.sizing && r.used.sizing !== "pct"
              ? `${r.used.sizing === "martingale" ? `Martingale ×${r.used.mgMult}` : "Fibonacci"} from a $${r.used.baseBet} base${
                r.used.resetAfter ? `, reset after ${r.used.resetAfter} losses` : ""
              } (biggest bet $${tt.maxStake ?? "—"})`
              : `${r.betPct}% of balance per trade`}, paid quote + {Math.round(r.gap * 100)}¢. Both traded {tt.bothTraded}{" "}
            windows; same side in {tt.sameSide}.
            {tt.cappedBuys
              ? ` Max fill price: ${tt.cappedBuys} calls would have filled above it and asked again.`
              : ""}
            {tt.takeProfits || tt.stopLosses
              ? ` Exits: ${tt.takeProfits ?? 0} take profit, ${tt.stopLosses ?? 0} stop loss (sold at the sell price − the gap).`
              : ""}
            {tt.patchyExits
              ? ` ⚠ ${tt.patchyExits} trades had gaps of 20 s+ in the recorded prices after buying, so their exits are rough.`
              : ""}
          </div>
          <table className="w-full text-xs tabular-nums">
            <thead className="text-[#8b949e]">
              <tr>
                <th className="text-left">Day</th><th className="text-right">Trades</th><th className="text-right">Won</th>
                <th className="text-right">P&L</th><th className="text-right">End balance</th>
              </tr>
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
                  <tr>
                    <th className="text-left">Window</th><th className="text-left">Jev</th><th className="text-left">Replay</th>
                    <th className="text-right">P&L</th><th className="pl-2 text-left">Real bot</th>
                  </tr>
                </thead>
                <tbody>
                  {[...r.trades].reverse().map((x) => (
                    <tr key={x.window} title={x.note} className="border-t border-[#21262d]">
                      <td>{time(x.window)} <span className="text-[#8b949e]">{Math.round(x.at)}s</span></td>
                      <td>{x.jev} {x.pct}%</td>
                      <td>
                        {x.entry && x.entry > 1 ? `#${x.entry} ` : ""}
                        {x.side} {x.quote}¢→{x.paid}¢ {x.against ? "(other side)" : ""}
                        {x.exit ? ` · ${x.exit.why} at ${x.exit.at}s, sold ${x.exit.fill}¢` : ""}
                        {x.patchy ? " ⚠" : ""}
                      </td>
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

        <ReplayBox live={s?.settings?.trader} balance={t?.balance} />

        <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-4">
          <FadeBotPanel bars={[]} readSec={null} readLabel="" pastIsLive={false} status={s} botOnly />
        </section>
      </div>
    </main>
  );
};

export default Bot;
