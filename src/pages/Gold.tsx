import { useEffect } from "react";
import { GoldChart } from "@/gold/GoldChart";
import { TIMEFRAME_MIN } from "@/gold/feed";
import type { TrackSummary } from "@/gold/model";
import { useGoldEngine } from "@/gold/useGoldEngine";
import { reversionAt } from "@/gold/reversion";

const pct = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const px = (x: number | null | undefined) => (x == null ? "—" : x.toFixed(2));

function RecordRow({ name, t }: { name: string; t: TrackSummary }) {
  const skillCls = t.skill == null ? "" : t.skill > 0 ? "text-[#26a69a]" : "text-[#ef5350]";
  return (
    <tr className="border-t border-[#262c36]">
      <td className="py-1 text-left">{name}</td>
      <td className="py-1 text-right">{t.calls >= 20 ? pct(t.hitRate) : "—"}</td>
      <td className="py-1 text-right">{t.calls || "—"}</td>
      <td className={`py-1 text-right ${skillCls}`}>{t.skill == null ? "—" : t.skill.toFixed(3)}</td>
    </tr>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#8b949e]">{children}</h2>
);

export default function Gold() {
  const g = useGoldEngine();
  const p = g.prediction;
  const s = g.summary;

  useEffect(() => {
    const prev = document.title;
    document.title = "Gold Next Candle";
    return () => {
      document.title = prev;
    };
  }, []);

  const lastCandle = g.forming ?? (g.bars.length ? g.bars[g.bars.length - 1].candle : null);
  const nc = g.live; // live read of the forming candle (null between candles)
  const isLive = !!nc;
  const colorOf = (c: -1 | 0 | 1 | undefined) => (c === 1 ? "green" : c === -1 ? "red" : "none");
  const clsOf = (d: string) => (d === "green" ? "text-[#26a69a]" : d === "red" ? "text-[#ef5350]" : "text-[#8b949e]");

  const dir = colorOf(isLive ? nc.call : p?.call);
  const prob = isLive ? nc.pGreen : (p?.pFinal ?? null);
  const dirText = !s?.warm ? "LEARNING" : dir === "none" ? (isLive ? "TOO CLOSE" : "NO CALL") : dir.toUpperCase();

  const move = nc?.move ?? 0;
  const secsLeft = nc ? Math.round(nc.timeLeftFrac * TIMEFRAME_MIN * 60) : 0;
  const clock = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")}`;
  const fc = g.forecastOn ? g.forecast : null;
  // With the forecast on, its first candle replaces the single ghost.
  const ghost = fc ? null : (nc?.ghost ?? p?.ghost ?? null);
  const ghostInfo = nc?.ghost ?? p?.ghost ?? null;

  const atOpen: string[] = [];
  if (p?.pModel != null) atOpen.push(`Model ${pct(p.pModel, 0)}`);
  if (g.jevOn) {
    if (p?.pJev != null) atOpen.push(`Jev ${pct(p.pJev, 0)}`);
    else if (g.jevPending) atOpen.push("Jev thinking…");
    else if (g.jevError) atOpen.push("Jev error (see below)");
  }
  if (p?.pFinal != null && (g.jevOn || isLive)) atOpen.push(`→ ${pct(p.pFinal, 0)}`);

  return (
    <div className="flex h-[100dvh] flex-col bg-[#0e1116] text-[#e6e8eb] [font-family:ui-sans-serif,system-ui,-apple-system,'Segoe_UI',sans-serif] [&_h1]:[font-family:inherit] [&_h2]:[font-family:inherit]">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-[#262c36] px-4 py-3">
        <h1 className="text-base font-semibold">
          <span className="text-[#d4a72c]">XAU/USD</span> · <span className="text-[#d4a72c]">{TIMEFRAME_MIN}m</span>
        </h1>
        <div className={`text-lg font-semibold tabular-nums ${lastCandle && lastCandle.close < lastCandle.open ? "text-[#ef5350]" : "text-[#26a69a]"}`}>
          {lastCandle ? lastCandle.close.toFixed(2) : "—"}
        </div>
        <button
          type="button"
          aria-pressed={g.forecastOn}
          onClick={() => g.setForecastOn(!g.forecastOn)}
          className={`ml-auto rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
            g.forecastOn ? "border-[#d4a72c] bg-[#d4a72c]/15 text-[#d4a72c]" : "border-[#262c36] text-[#8b949e] hover:text-[#e6e8eb]"
          }`}
        >
          Forecast 5 {g.forecastOn ? "on" : "off"}
        </button>
        <div className={`text-xs ${g.source === "Simulated" ? "text-[#d4a72c]" : "text-[#8b949e]"}`}>
          {g.status === "loading" ? "loading…" : g.source === "Simulated" ? "SIMULATED DATA" : "Pyth live"}
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[58vh_auto] md:grid-cols-[1fr_300px] md:grid-rows-1">
        <div className="relative min-h-0">
          <GoldChart bars={g.bars} forming={g.forming} ghost={ghost} forecast={fc?.candles ?? null} version={g.version} />
          {g.status === "loading" && (
            <div className="absolute inset-0 grid place-items-center text-sm text-[#8b949e]">Training on history…</div>
          )}
        </div>

        <aside className="flex flex-col gap-5 overflow-auto border-t border-[#262c36] bg-[#161b22] p-4 md:border-l md:border-t-0">
          <div className="rounded-xl bg-[#1f252e] p-4 text-center">
            <div className="text-xs uppercase tracking-wider text-[#8b949e]">
              {isLive ? "This candle · live" : "Next candle"}
            </div>
            <div className={`my-0.5 text-3xl font-bold ${clsOf(dir)}`}>{p ? dirText : "—"}</div>
            <div className="tabular-nums">{prob == null ? "—" : `${pct(prob)} chance green`}</div>
            {isLive && (
              <>
                <div className="mx-auto mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#ef5350]/40">
                  <div className="h-full bg-[#26a69a] transition-[width] duration-300" style={{ width: `${(prob ?? 0.5) * 100}%` }} />
                </div>
                <div className="mt-2 text-sm tabular-nums">
                  <span className={clsOf(move > 0 ? "green" : move < 0 ? "red" : "none")}>
                    {move >= 0 ? "+" : ""}
                    {move.toFixed(2)} so far
                  </span>
                  <span className="text-[#8b949e]"> · {clock} left</span>
                </div>
                {g.jevOn && (
                  <div className="mt-1 text-xs tabular-nums text-[#8b949e]">
                    {g.jevLive
                      ? `Jev live: ${pct(g.jevLive.pGreen, 0)} green · ${Math.max(0, Math.round((Date.now() - g.jevLive.at) / 1000))}s ago`
                      : "Jev live: —"}
                    {g.jevLiveStatus !== "reading" && <div className="text-[#d4a72c]">{g.jevLiveStatus}</div>}
                  </div>
                )}
              </>
            )}
            <div className="mt-1.5 text-xs tabular-nums text-[#8b949e]">
              {atOpen.length ? `${isLive ? "At the open: " : ""}${atOpen.join(" · ")}` : "\u00a0"}
            </div>
          </div>

          {g.forecastOn && (
            <section>
              <Label>Forecast · next 5 candles</Label>
              {!fc ? (
                <p className="text-sm text-[#8b949e]">{g.forecastBusy ? "Jev is weighing the paths…" : "building paths…"}</p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-[#8b949e]">
                    {fc.picked === "jev"
                      ? `Jev's pick out of ${fc.scenarios} real gold paths: ${pct(fc.pJev, 1)} likely (an even guess would be ${pct(1 / fc.scenarios, 1)}).`
                      : `Most typical of ${fc.scenarios} real gold paths.`}{" "}
                    {pct(fc.endsHigherPct, 0)} of all paths end higher.
                  </p>
                  <ol className="grid gap-1 tabular-nums">
                    {fc.candles.map((c, i) => {
                      const d = c.close - c.open;
                      return (
                        <li key={c.time} className="flex justify-between gap-2 text-sm">
                          <span className="text-[#8b949e]">
                            {i + 1}. {new Date(c.time * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                          </span>
                          <span className={d >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}>
                            {d >= 0 ? "▲ +" : "▼ "}
                            {d.toFixed(2)}
                          </span>
                          <span className="text-[#8b949e]">
                            {c.low.toFixed(1)}–{c.high.toFixed(1)}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                  {fc.note && <p className="mt-2 text-xs text-[#d4a72c]">{fc.note}</p>}
                </>
              )}
            </section>
          )}

          <section>
            <Label>Ghost candle</Label>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 tabular-nums">
              <dt className="text-[#8b949e]">Expected high</dt>
              <dd className="text-right">{px(ghostInfo?.high)}</dd>
              <dt className="text-[#8b949e]">Expected close</dt>
              <dd className="text-right">{px(ghostInfo?.close)}</dd>
              <dt className="text-[#8b949e]">Expected low</dt>
              <dd className="text-right">{px(ghostInfo?.low)}</dd>
            </dl>
          </section>

          <section>
            <Label>Mean reversion (measured)</Label>
            {g.reversion ? (
              <p className="text-sm text-[#8b949e]">
                A move at the halfway point keeps{" "}
                <span className="text-[#e6e8eb]">{pct(reversionAt(g.reversion, g.reversion.minutesPerCandle / 2).hold, 0)}</span> of itself by
                the close, on average. After 3 minutes it keeps{" "}
                <span className="text-[#e6e8eb]">{pct(reversionAt(g.reversion, 3).hold, 0)}</span>. Measured from {g.reversion.candles} candles of
                1-minute gold data.
              </p>
            ) : (
              <p className="text-sm text-[#8b949e]">{g.source === "Simulated" ? "Needs live data." : "Measuring from 1-minute history…"}</p>
            )}
          </section>

          <section>
            <Label>Why</Label>
            <ul className="grid gap-1.5">
              {p?.drivers.length ? (
                p.drivers.map((d) => (
                  <li key={d.name} className="flex justify-between gap-2">
                    <span>{d.name}</span>
                    <span className={d.push > 0 ? "text-[#26a69a]" : "text-[#ef5350]"}>{d.push > 0 ? "↑ green" : "↓ red"}</span>
                  </li>
                ))
              ) : (
                <li className="text-[#8b949e]">{s?.warm ? "nothing stands out" : "warming up"}</li>
              )}
            </ul>
          </section>

          <section>
            <Label>Out-of-sample record</Label>
            {s && (
              <table className="w-full tabular-nums">
                <thead>
                  <tr className="text-xs text-[#8b949e]">
                    <th className="pb-1.5 text-left font-medium"></th>
                    <th className="pb-1.5 text-right font-medium">Hit rate</th>
                    <th className="pb-1.5 text-right font-medium">Calls</th>
                    <th className="pb-1.5 text-right font-medium">Skill</th>
                  </tr>
                </thead>
                <tbody>
                  {g.jevOn && <RecordRow name="Blend" t={s.final} />}
                  <RecordRow name="Model" t={s.model} />
                  <RecordRow name="Live @ halfway" t={s.halfway} />
                  {g.jevOn && <RecordRow name="Jev" t={s.jev} />}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-[#8b949e]">
              Always guessing the more common color: {pct(s?.model.majority)}. Ghost held the candle {pct(s?.shape.insideRate, 0)} of the time.
            </p>
            {g.jevOn && (
              <p className="mt-2 text-xs tabular-nums text-[#8b949e]">
                Jev calls this session: {g.jevCalls.open} at candle open · {g.jevCalls.live} live · {g.jevCalls.skipped} skipped (nothing new)
              </p>
            )}
            <p className="mt-2 text-xs text-[#8b949e]">
              Skill above 0 means real information beyond the base rate. Every number here comes from predictions made before the candle happened.
            </p>
            {(g.error || g.jevError || (s && !s.warm)) && (
              <p className="mt-2 text-xs text-[#d4a72c]">
                {s && !s.warm && `Learning: ${s.learnedFrom} of ${s.warmup} candles before calls count. `}
                {g.error && `${g.error} `}
                {g.jevError && `Jev error: ${g.jevError}`}
              </p>
            )}
          </section>

          <div className="flex flex-wrap gap-3 text-xs text-[#8b949e]">
            <span>▲▼ call on that candle (gray = missed)</span>
            <span>faded candle = ghost</span>
          </div>
        </aside>
      </main>
    </div>
  );
}
