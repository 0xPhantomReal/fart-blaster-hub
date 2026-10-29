import { useEffect, useState } from "react";
import { GoldChart } from "@/gold/GoldChart";
import { TIMEFRAMES, type Timeframe } from "@/gold/feed";
import { SUPPORT_NEEDED, type TrackRecord } from "@/gold/predictor";
import { BACKFILL, useGold } from "@/gold/useGold";
import type { CatchRecord, FlipRecords } from "@/gold/flip";
import type { PathRecord } from "@/gold/forecast";

const pct = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const time = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const GREEN = "text-[#26a69a]";
const RED = "text-[#ef5350]";
const MUTED = "text-[#8b949e]";

const SUPPORT_WORDS = ["points the other way", "is mixed or weak", "mostly supports it", "clearly supports it"];

function Row({ name, r, note }: { name: string; r: TrackRecord | null | undefined; note?: string }) {
  if (!r) return null;
  const skill = r.skill;
  return (
    <tr className="border-t border-[#262c36]">
      <td className="py-1.5 text-left">
        {name}
        {note && <span className={`text-xs ${MUTED}`}> · {note}</span>}
      </td>
      <td className="py-1.5 text-right">{r.calls >= 20 ? pct(r.hitRate) : "—"}</td>
      <td className="py-1.5 text-right">{r.calls.toLocaleString()}</td>
      <td className={`py-1.5 text-right ${skill == null ? "" : skill > 0.002 ? GREEN : skill < -0.002 ? RED : ""}`}>
        {skill == null ? "—" : (Math.abs(skill) < 0.0005 ? 0 : skill).toFixed(3)}
      </td>
    </tr>
  );
}

function RecordTable({ children }: { children: React.ReactNode }) {
  return (
    <table className="w-full text-sm tabular-nums">
      <thead>
        <tr className={`text-xs ${MUTED}`}>
          <th className="pb-1 text-left font-medium"></th>
          <th className="pb-1 text-right font-medium">Right</th>
          <th className="pb-1 text-right font-medium">Calls</th>
          <th className="pb-1 text-right font-medium">Skill</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** Flips caught: of the candles that flipped after the read, how many each one saw coming. */
function FlipTable({ rec, where }: { rec: FlipRecords; where: string }) {
  const row = (name: string, r: CatchRecord) => {
    const said = r.caught + r.alarms;
    return (
      <tr key={name} className="border-t border-[#262c36]">
        <td className="py-1.5 text-left">{name}</td>
        <td className="py-1.5 text-right">
          {r.caught} of {r.flips}
        </td>
        <td className="py-1.5 text-right">{r.alarms}</td>
        <td className="py-1.5 text-right">{said ? `${pct(r.caught / said, 0)} (${said})` : "—"}</td>
      </tr>
    );
  };
  return (
    <>
      <p className={`mb-2 mt-4 text-xs ${MUTED}`}>
        {where}: {rec.math.flips} of {rec.n} candles flipped after the read ({pct(rec.n ? rec.math.flips / rec.n : null, 0)}).
      </p>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className={`text-xs ${MUTED}`}>
            <th className="pb-1 text-left font-medium"></th>
            <th className="pb-1 text-right font-medium">Caught</th>
            <th className="pb-1 text-right font-medium">False alarm</th>
            <th className="pb-1 text-right font-medium">Right on flip</th>
          </tr>
        </thead>
        <tbody>
          {row("Math", rec.math)}
          {row("Jev", rec.jev)}
          {row("Live %", rec.blend)}
        </tbody>
      </table>
    </>
  );
}

function load<T>(key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // remembered for this visit only
  }
}
const isTf = (v: unknown): v is Timeframe => (TIMEFRAMES as readonly unknown[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Forecast scores: first bar's color, and direction after 5 bars. */
function PathRow({ name, r, note }: { name: string; r: PathRecord; note: string }) {
  const cell = (x: { right: number; n: number }) => (x.n >= 10 ? `${pct(x.right / x.n, 0)}` : "—");
  return (
    <tr className="border-t border-[#262c36]">
      <td className="py-1.5 text-left">
        {name}
        <span className={`text-xs ${MUTED}`}> · {note}</span>
      </td>
      <td className="py-1.5 text-right">{cell(r.first)}</td>
      <td className="py-1.5 text-right">{cell(r.end)}</td>
      <td className="py-1.5 text-right">{r.end.n}</td>
    </tr>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <h2 className={`mb-2 text-xs font-semibold uppercase tracking-wider ${MUTED}`}>{children}</h2>
);

export default function Gold() {
  const [tfMin, setTfMin] = useState<Timeframe>(() => load("gold.tf", isTf, 15));
  const [forecastOn, setForecastOn] = useState<boolean>(() => load("gold.forecast", isBool, true));
  useEffect(() => save("gold.tf", tfMin), [tfMin]);
  useEffect(() => save("gold.forecast", forecastOn), [forecastOn]);
  const g = useGold(tfMin, forecastOn);
  const fc = g.forecast;
  const p = g.prediction;
  const [, tick] = useState(0);

  useEffect(() => {
    const prev = document.title;
    document.title = "Gold Next Candle";
    const id = setInterval(() => tick((n) => n + 1), 1000); // keep the countdown moving
    return () => {
      document.title = prev;
      clearInterval(id);
    };
  }, []);

  const last = g.forming ?? (g.bars.length ? g.bars[g.bars.length - 1].candle : null);
  const tf = tfMin * 60;
  const isForming = !!(p && g.forming && g.forming.time === p.forTime);
  const closesAt = p ? p.forTime + tf : null;
  const secsLeft = closesAt && g.source !== "Simulated" ? Math.max(0, Math.round(closesAt - Date.now() / 1000)) : null;

  const lv = isForming ? g.live : null; // live read while the candle forms
  const openDir = p?.call === 1 ? "green" : p?.call === -1 ? "red" : "none";
  const callOf = (c: -1 | 0 | 1 | undefined) => (c === 1 ? "green" : c === -1 ? "red" : "none");
  const dir = lv ? callOf(lv.call) : openDir;
  const big = !p ? "—" : dir === "none" ? (lv ? "TOO CLOSE" : "NO CALL") : dir.toUpperCase();
  const bigCls = dir === "green" ? GREEN : dir === "red" ? RED : MUTED;
  const prob = lv ? lv.pGreen : (p?.pFinal ?? null);
  const modelDir = p?.modelCall === 1 ? "green" : p?.modelCall === -1 ? "red" : null;

  return (
    <div className="flex h-[100dvh] flex-col bg-[#0e1116] text-[#e6e8eb] [font-family:ui-sans-serif,system-ui,-apple-system,'Segoe_UI',sans-serif] [&_h1]:[font-family:inherit] [&_h2]:[font-family:inherit]">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-[#262c36] px-4 py-3">
        <h1 className="text-base font-semibold">
          <span className="text-[#d4a72c]">XAU/USD</span>
        </h1>
        <div className="flex self-center overflow-hidden rounded-md border border-[#262c36] text-xs">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              onClick={() => setTfMin(t)}
              className={`px-2.5 py-1 ${t === tfMin ? "bg-[#d4a72c] font-semibold text-[#0e1116]" : "text-[#8b949e] hover:bg-[#1f252e]"}`}
            >
              {t}m
            </button>
          ))}
        </div>
        <button
          onClick={() => setForecastOn((v) => !v)}
          className={`self-center rounded-md border px-2.5 py-1 text-xs ${forecastOn ? "border-[#d4a72c] text-[#d4a72c]" : "border-[#262c36] text-[#8b949e]"}`}
        >
          Forecast {forecastOn ? "on" : "off"}
        </button>
        <div className={`text-lg font-semibold tabular-nums ${last && last.close < last.open ? RED : GREEN}`}>{last ? last.close.toFixed(2) : "—"}</div>
        <div className={`ml-auto text-xs ${g.source === "Simulated" ? "text-[#d4a72c]" : MUTED}`}>
          {g.status === "loading" ? "loading…" : g.source === "Simulated" ? "SIMULATED DATA" : "Pyth live"}
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[56vh_auto] md:grid-cols-[1fr_320px] md:grid-rows-1">
        <div className="relative min-h-0">
          <GoldChart key={tfMin} bars={g.bars} forming={g.forming} version={g.version} forecast={forecastOn ? fc.candles : null} />
          {g.status === "loading" && <div className={`absolute inset-0 grid place-items-center text-sm ${MUTED}`}>Loading gold history…</div>}
        </div>

        <aside className="flex flex-col gap-6 overflow-auto border-t border-[#262c36] bg-[#161b22] p-4 md:border-l md:border-t-0">
          <div className="rounded-xl bg-[#1f252e] p-4 text-center">
            <div className={`text-xs uppercase tracking-wider ${MUTED}`}>
              {isForming ? "This candle" : "Next candle"}
              {closesAt ? ` · closes ${time(closesAt)}` : ""}
              {secsLeft !== null ? ` · ${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")} left` : ""}
            </div>
            <div className={`my-1 text-3xl font-bold ${bigCls}`}>{big}</div>
            <div className="text-lg tabular-nums">
              {prob == null ? "—" : `${pct(prob)} chance green`}
              {lv && <span className={`ml-1 text-xs ${MUTED}`}>live</span>}
            </div>
            {lv && (
              <>
                <div className="mx-auto mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#ef5350]/40">
                  <div className="h-full bg-[#26a69a] transition-[width] duration-300" style={{ width: `${lv.pGreen * 100}%` }} />
                </div>
                <div className="mt-2 text-sm tabular-nums">
                  <span className={lv.move > 0 ? GREEN : lv.move < 0 ? RED : MUTED}>
                    {lv.move >= 0 ? "+" : ""}
                    {lv.move.toFixed(2)} so far
                  </span>
                  {lv.move !== 0 && (
                    <span className={MUTED}> · currently {lv.move > 0 ? "green" : "red"}</span>
                  )}
                </div>
                {g.flip.pFlip !== null && g.flip.at !== null && Date.now() - g.flip.at < 20_000 && lv.move !== 0 && (
                  <div className="mt-1 text-sm tabular-nums">
                    Jev: <span className={g.flip.pFlip >= 0.5 ? "text-[#d4a72c]" : ""}>{pct(g.flip.pFlip, 0)} chance it flips</span>
                    {lv.pMath != null && (
                      <span className={`text-xs ${MUTED}`}>
                        {" "}· math alone {pct(lv.move > 0 ? 1 - lv.pMath : lv.pMath, 0)}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
            <div className={`mt-2 text-xs tabular-nums ${MUTED}`}>
              {lv ? (
                <>
                  At the open: <span className={openDir === "green" ? GREEN : openDir === "red" ? RED : ""}>{openDir === "none" ? "no call" : openDir}</span>{" "}
                  {pct(p?.pFinal, 0)} ·{" "}
                </>
              ) : null}
              Model {pct(p?.pModel, 0)}
              {p?.jev ? ` · Jev ${pct(p.jev.pGreen, 0)}` : ""}
            </div>
            {p?.jev && p.jev.support !== null && modelDir && (
              <div className={`mt-1 text-xs ${p.blockedByCheck ? "text-[#d4a72c]" : MUTED}`}>
                Jev's fact-check of the model's {modelDir} call: the evidence{" "}
                {SUPPORT_WORDS[Math.round(Math.min(3, Math.max(0, p.jev.support)))]} ({p.jev.support.toFixed(1)}/3)
                {p.blockedByCheck ? " → no call" : ""}
              </div>
            )}
          </div>

          <section>
            <Label>How accurate is it?</Label>
            <p className={`mb-2 text-xs ${MUTED}`}>Tested on past candles, each predicted before it happened:</p>
            <RecordTable>
              <Row name="Model" r={g.walkForward} note={`${g.walkForward?.n.toLocaleString() ?? 0} candles`} />
              {g.backfill && (
                <>
                  <Row name="Model" r={g.backfill.model} note={`last ${BACKFILL}`} />
                  <Row name="Jev" r={g.backfill.jev} note={`last ${BACKFILL}`} />
                  <Row name="Final" r={g.backfill.final} note={`last ${BACKFILL}`} />
                </>
              )}
            </RecordTable>
            {g.liveRecord && g.liveRecord.model.n > 0 && (
              <>
                <p className={`mb-2 mt-4 text-xs ${MUTED}`}>Live, since this page opened:</p>
                <RecordTable>
                  <Row name="Model" r={g.liveRecord.model} />
                  {g.jev.on && <Row name="Jev" r={g.liveRecord.jev} />}
                  <Row name="Final" r={g.liveRecord.final} />
                  <Row name="Live % at halfway" r={g.liveRecord.halfway} />
                </RecordTable>
              </>
            )}
            {(g.flip.backfill || (g.flip.live && g.flip.live.n > 0)) && (
              <>
                <h3 className="mt-5 text-sm font-medium">Flips caught</h3>
                <p className={`mt-1 text-xs ${MUTED}`}>
                  Read partway through each candle. Counts only candles that changed color after the read. A read "says flip"
                  when it gives the flip more than 50%.
                </p>
                {g.flip.backfill && <FlipTable rec={g.flip.backfill} where="Past candles" />}
                {g.flip.live && g.flip.live.n > 0 && <FlipTable rec={g.flip.live} where="Live, one read per candle at halfway" />}
              </>
            )}
            <p className={`mt-3 text-xs ${MUTED}`}>
              The open forecast (Model, Jev, Final) is made before the candle starts; the live % also uses what the candle
              has done so far, so it naturally gets more certain as the candle runs.
              Right = share of calls that were correct. A call needs at least 55% one way; Final also needs Jev's fact-check to
              score {SUPPORT_NEEDED}+ of 3. Skill above 0 means the forecasts carry real information beyond the base rate; at or
              below 0 there's no edge, whatever the hit rate looks like. Expect small numbers: {tfMin}-minute gold is close to a coin
              flip.
            </p>
          </section>

          <section>
            <Label>Jev</Label>
            <p className={`text-sm ${g.jev.status.startsWith("error") || g.jev.status.startsWith("waiting") ? "text-[#d4a72c]" : MUTED}`}>
              {g.jev.status === "ok" ? "Checking each candle." : g.jev.status}
            </p>
            {g.jev.on && (
              <p className={`mt-1 text-xs ${MUTED}`}>
                Each candle, Jev makes its own call from the candles and signals (without seeing the model), and separately
                fact-checks the model's call. {g.jev.calls} Jev calls this session
                {g.trust ? ` · weight in the blend: Jev ${g.trust.jev.toFixed(2)}, model ${g.trust.model.toFixed(2)}` : ""}.
              </p>
            )}
          </section>

          {forecastOn && (
            <section>
              <Label>Forecast · next 5 candles</Label>
              <p className="text-sm">
                {fc.source === "jev"
                  ? `Jev's pick of the 50 most similar past moments${fc.pickedPct != null ? ` (${pct(fc.pickedPct, 0)} of its vote)` : ""}.`
                  : fc.source === "typical"
                    ? "The most typical of the 50 most similar past moments."
                    : "—"}
                {fc.endsHigherPct != null && (
                  <span className={MUTED}> {pct(fc.endsHigherPct, 0)} of those 50 ended higher after 5 candles.</span>
                )}
              </p>
              {fc.status !== "ok" && <p className={`mt-1 text-xs ${/couldn|waiting/.test(fc.status) ? "text-[#d4a72c]" : MUTED}`}>{fc.status}</p>}
              {(fc.replay || fc.live) && (
                <table className="mt-3 w-full text-sm tabular-nums">
                  <thead>
                    <tr className={`text-xs ${MUTED}`}>
                      <th className="pb-1 text-left font-medium"></th>
                      <th className="pb-1 text-right font-medium">1st bar color</th>
                      <th className="pb-1 text-right font-medium">Direction at 5</th>
                      <th className="pb-1 text-right font-medium">n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fc.replay && <PathRow name="Typical" r={fc.replay} note="past 200" />}
                    {fc.live && fc.live.typical.end.n > 0 && <PathRow name="Typical" r={fc.live.typical} note="live" />}
                    {fc.live && fc.live.jev.end.n > 0 && <PathRow name="Jev's pick" r={fc.live.jev} note="live" />}
                  </tbody>
                </table>
              )}
              <p className={`mt-2 text-xs ${MUTED}`}>
                Faded bars on the chart. Each is something gold really did after a moment like this one, rescaled to today's
                volatility and redrawn at every close. Right % above 50 is an edge; around 50 the bars are only a picture of
                typical behaviour, not a prediction. {fc.calls} Jev picks this session.
              </p>
            </section>
          )}

          <section>
            <Label>Jev flip check</Label>
            <p className={`text-sm ${g.flip.status.startsWith("error") || g.flip.status.startsWith("waiting") ? "text-[#d4a72c]" : MUTED}`}>
              {g.flip.status === "ok" ? "Reading the forming candle every 3 seconds (when it has changed)." : g.flip.status}
            </p>
            <p className={`mt-1 text-xs ${MUTED}`}>
              While a candle forms, Jev sees how far it has moved, its high/low, how much it has pulled back, the time left and
              the last 3 candles (sizes only, no prices) and answers one question: does it hold its color or flip? The live % blends
              that with the math, weighted by how each scored on past candles rebuilt partway through from 1-minute data.
              {` ${g.flip.calls} flip calls this session`}
              {g.flip.weights ? ` · weight: Jev ${g.flip.weights.jev.toFixed(2)}, math ${g.flip.weights.math.toFixed(2)}` : ""}.
            </p>
          </section>

          {g.source !== "Simulated" && (
            <section>
              <Label>Live ticks</Label>
              <p className={`text-sm ${g.ticks.state === "fallback" ? "text-[#d4a72c]" : MUTED}`}>
                {g.ticks.state === "streaming"
                  ? "Streaming every Pyth price update."
                  : g.ticks.state === "connecting"
                    ? "Connecting to the Pyth tick stream…"
                    : `Not streaming (${g.ticks.detail}). The candle updates from 1-minute data every few seconds instead.`}
              </p>
              {g.ticks.state === "fallback" && g.ticks.check && (
                <div className={`mt-1 text-xs ${MUTED}`}>
                  {g.ticks.check.ok ? (
                    <>
                      Backend test: the stream works ({g.ticks.check.host}, first price {g.ticks.check.firstPrice?.toFixed(2)}), so the
                      problem is between the backend and this page. Reload; if it persists, tell Claude.
                    </>
                  ) : (
                    <>
                      Backend test: {g.ticks.check.problems.join(" · ")}
                      {g.ticks.check.feedSource === "fallback" ? " (couldn't look up the gold feed; tried the standard XAU/USD feed id)" : ""}.
                      {g.ticks.check.problems.some((x) => /401|403|unauthor|forbidden/i.test(x))
                        ? " Your Pyth key isn't accepted for live ticks: add a Pyth Core/Hermes key as the secret PYTH_HERMES_KEY."
                        : ""}
                    </>
                  )}
                </div>
              )}
            </section>
          )}

          {g.error && <p className="text-xs text-[#d4a72c]">{g.error}</p>}
          <p className={`text-xs ${MUTED}`}>
            Arrows mark candles a call was made for: colored = right, gray = wrong. Trained on {g.trainedOn.toLocaleString()} candles.
          </p>
        </aside>
      </main>
    </div>
  );
}
