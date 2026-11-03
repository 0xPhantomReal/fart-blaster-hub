import { useEffect, useState } from "react";
import { GoldChart } from "@/gold/GoldChart";
import { minuteChoices, readLabel, readShort } from "@/gold/minuteCall";
import { MARKETS, TIMEFRAMES, type Market, type Timeframe } from "@/gold/feed";
import { SUPPORT_NEEDED, type TrackRecord } from "@/gold/predictor";
import { BACKFILL, useGold } from "@/gold/useGold";
import type { CatchRecord, FlipRecords } from "@/gold/flip";
import type { PathRecord } from "@/gold/forecast";

const pct = (x: number | null | undefined, d = 1) =>
  x == null ? "—" : `${(x * 100).toFixed(d)}%`;
const time = (t: number) =>
  new Date(t * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
const GREEN = "text-[#26a69a]";
const RED = "text-[#ef5350]";
const MUTED = "text-[#8b949e]";

const SUPPORT_WORDS = [
  "points the other way",
  "is mixed or weak",
  "mostly supports it",
  "clearly supports it",
];

function Row({
  name,
  r,
  note,
}: {
  name: string;
  r: TrackRecord | null | undefined;
  note?: string;
}) {
  if (!r) return null;
  const skill = r.skill;
  return (
    <tr className="border-t border-[#262c36]">
      <td className="py-1.5 text-left">
        {name}
        {note && <span className={`text-xs ${MUTED}`}> · {note}</span>}
      </td>
      <td className="py-1.5 text-right">
        {r.calls >= 20 ? pct(r.hitRate) : "—"}
      </td>
      <td className="py-1.5 text-right">{r.calls.toLocaleString()}</td>
      <td
        className={`py-1.5 text-right ${skill == null ? "" : skill > 0.002 ? GREEN : skill < -0.002 ? RED : ""}`}
      >
        {skill == null
          ? "—"
          : (Math.abs(skill) < 0.0005 ? 0 : skill).toFixed(3)}
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
        <td className="py-1.5 text-right">
          {said ? `${pct(r.caught / said, 0)} (${said})` : "—"}
        </td>
      </tr>
    );
  };
  return (
    <>
      <p className={`mb-2 mt-4 text-xs ${MUTED}`}>
        {where}: {rec.math.flips} of {rec.n} candles flipped after the read (
        {pct(rec.n ? rec.math.flips / rec.n : null, 0)}).
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
const isTf = (v: unknown): v is Timeframe =>
  (TIMEFRAMES as readonly unknown[]).includes(v);
type ArrowMode = "jev" | "refined" | "minute";
const isMarket = (v: unknown): v is Market =>
  typeof v === "string" && v in MARKETS;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Forecast scores: first bar's color, and direction after 5 bars. */
function PathRow({
  name,
  r,
  note,
}: {
  name: string;
  r: PathRecord;
  note: string;
}) {
  const cell = (x: { right: number; n: number }) =>
    x.n >= 10 ? `${pct(x.right / x.n, 0)}` : "—";
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
  <h2
    className={`mb-2 text-xs font-semibold uppercase tracking-wider ${MUTED}`}
  >
    {children}
  </h2>
);

export default function Gold() {
  const [market, setMarket] = useState<Market>(() =>
    load("gold.market", isMarket, "gold"),
  );
  const [tfPick, setTfMin] = useState<Timeframe>(() =>
    load("gold.tf", isTf, 15),
  );
  const mk = MARKETS[market];
  // Bitcoin offers 5m and 15m only; a 1m pick from gold falls back to 5m there.
  const tfMin: Timeframe = mk.timeframes.includes(tfPick) ? tfPick : 5;
  useEffect(() => save("gold.market", market), [market]);
  const [arrows, setArrows] = useState<ArrowMode>(() =>
    load(
      "gold.arrows",
      (v): v is ArrowMode => v === "jev" || v === "refined" || v === "minute",
      "jev",
    ),
  );
  useEffect(() => save("gold.arrows", arrows), [arrows]);
  const [minConf, setMinConf] = useState<number>(() =>
    load(
      "gold.minconf",
      (v): v is number => typeof v === "number" && v >= 0.5 && v < 0.9,
      0.5,
    ),
  );
  useEffect(() => save("gold.minconf", minConf), [minConf]);
  const [footprintOn, setFootprintOn] = useState<boolean>(() =>
    load("gold.footprint", isBool, false),
  );
  useEffect(() => save("gold.footprint", footprintOn), [footprintOn]);
  const [forecastOn, setForecastOn] = useState<boolean>(() =>
    load("gold.forecast", isBool, true),
  );
  useEffect(() => save("gold.tf", tfMin), [tfMin]);
  useEffect(() => save("gold.forecast", forecastOn), [forecastOn]);
  const [minutePick, setMinutePick] = useState<number>(() =>
    load("gold.callminute", (v): v is number => typeof v === "number", 3),
  );
  useEffect(() => save("gold.callminute", minutePick), [minutePick]);
  const minuteOpts = minuteChoices(tfMin);
  const callMinute = minuteOpts.length
    ? minuteOpts.includes(minutePick)
      ? minutePick
      : minuteOpts[minuteOpts.length - 1]
    : null;
  const arrowMode: ArrowMode =
    arrows === "minute" && callMinute === null ? "jev" : arrows;
  const g = useGold(
    market,
    tfMin,
    forecastOn,
    arrowMode === "minute" ? callMinute : null,
  );
  const mn = g.minute;
  /** Jev's minute-X reads on the chart's candles, bucketed by how sure it was, vs "holds" on the same candles. */
  const byConf = [
    [0.5, 0.6],
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 0.9],
    [0.9, 1.01],
  ].map(([lo, hi]) => {
    let n = 0;
    let jev = 0;
    let holds = 0;
    for (const b of g.bars) {
      const p = b.pMin;
      const mv = b.minMove;
      const c = b.candle;
      if (
        p === undefined ||
        mv === undefined ||
        mv === 0 ||
        p === 0.5 ||
        c.close === c.open
      )
        continue;
      const sure = Math.max(p, 1 - p);
      if (sure < lo || sure >= hi) continue;
      const green = c.close > c.open;
      n += 1;
      if (p > 0.5 === green) jev += 1;
      if (mv > 0 === green) holds += 1;
    }
    return {
      label: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`,
      n,
      jev: n ? jev / n : 0,
      holds: n ? holds / n : 0,
    };
  });
  const cols: [ArrowMode, string][] =
    arrowMode === "minute"
      ? [["minute", `Jev at ${readLabel(callMinute!)}`]]
      : [
          ["jev", "Jev"],
          ["refined", "Refined"],
        ];
  const fc = g.forecast;
  /** Right / total for arrows at least `conf` sure, from Jev's or the refined %. */
  const tallyAt = (src: ArrowMode, conf: number) =>
    g.bars.reduce(
      (acc, b) => {
        const pp =
          src === "refined" ? b.pRef : src === "minute" ? b.pMin : b.pJev;
        const c = b.candle;
        if (
          pp === undefined ||
          pp === 0.5 ||
          c.close === c.open ||
          Math.max(pp, 1 - pp) < conf
        )
          return acc;
        return {
          n: acc.n + 1,
          right: acc.right + (pp > 0.5 === c.close > c.open ? 1 : 0),
        };
      },
      { n: 0, right: 0 },
    );
  const jevArrows = tallyAt(arrowMode, minConf);
  const p = g.prediction;
  const [, tick] = useState(0);

  useEffect(() => {
    const prev = document.title;
    const id = setInterval(() => tick((n) => n + 1), 1000); // keep the countdown moving
    return () => {
      document.title = prev;
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    document.title = `${mk.label} Next Candle`;
  }, [mk.label]);

  const last =
    g.forming ?? (g.bars.length ? g.bars[g.bars.length - 1].candle : null);
  const tf = tfMin * 60;
  const isForming = !!(p && g.forming && g.forming.time === p.forTime);
  const closesAt = p ? p.forTime + tf : null;
  const secsLeft =
    closesAt && g.source !== "Simulated"
      ? Math.max(0, Math.round(closesAt - Date.now() / 1000))
      : null;

  const lv = isForming ? g.live : null; // live read while the candle forms
  const openDir = p?.call === 1 ? "green" : p?.call === -1 ? "red" : "none";
  const callOf = (c: -1 | 0 | 1 | undefined) =>
    c === 1 ? "green" : c === -1 ? "red" : "none";
  const dir = lv ? callOf(lv.call) : openDir;
  const big = !p
    ? "—"
    : dir === "none"
      ? lv
        ? "TOO CLOSE"
        : "NO CALL"
      : dir.toUpperCase();
  const bigCls = dir === "green" ? GREEN : dir === "red" ? RED : MUTED;
  const prob = lv ? lv.pGreen : (p?.pFinal ?? null);
  const modelDir =
    p?.modelCall === 1 ? "green" : p?.modelCall === -1 ? "red" : null;

  return (
    <div className="flex h-[100dvh] flex-col bg-[#0e1116] text-[#e6e8eb] [font-family:ui-sans-serif,system-ui,-apple-system,'Segoe_UI',sans-serif] [&_h1]:[font-family:inherit] [&_h2]:[font-family:inherit]">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-[#262c36] px-4 py-3">
        <h1 className="text-base font-semibold">
          <span className="text-[#d4a72c]">{mk.pair}</span>
        </h1>
        <select
          value={market}
          onChange={(e) => setMarket(e.target.value as Market)}
          className="self-center rounded-md border border-[#262c36] bg-[#161b22] px-2 py-1 text-xs text-[#e6e8eb]"
          aria-label="Market"
        >
          {(Object.keys(MARKETS) as Market[]).map((m) => (
            <option key={m} value={m}>
              {MARKETS[m].label}
            </option>
          ))}
        </select>
        <div className="flex self-center overflow-hidden rounded-md border border-[#262c36] text-xs">
          {TIMEFRAMES.filter((t) => mk.timeframes.includes(t)).map((t) => (
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
        {mk.coinbase && (
          <button
            onClick={() => setFootprintOn((v) => !v)}
            className={`self-center rounded-md border px-2.5 py-1 text-xs ${footprintOn ? "border-[#d4a72c] text-[#d4a72c]" : "border-[#262c36] text-[#8b949e]"}`}
            title="Volume footprint candles from Coinbase trades"
          >
            Footprint {footprintOn ? "on" : "off"}
          </button>
        )}
        <div
          className={`text-lg font-semibold tabular-nums ${last && last.close < last.open ? RED : GREEN}`}
        >
          {last ? last.close.toFixed(mk.decimals) : "—"}
        </div>
        <div
          className={`ml-auto text-xs ${g.source === "Simulated" ? "text-[#d4a72c]" : MUTED}`}
        >
          {g.status === "loading"
            ? "loading…"
            : g.source === "Simulated"
              ? "SIMULATED DATA"
              : g.ticks.state === "streaming" &&
                  g.ticks.source &&
                  g.ticks.source !== "Pyth"
                ? `${g.ticks.source} live`
                : "Pyth live"}
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[56vh_auto] md:grid-cols-[1fr_320px] md:grid-rows-1">
        <div className="relative min-h-0">
          <GoldChart
            key={`${market}-${tfMin}`}
            bars={g.bars}
            forming={g.forming}
            version={g.version}
            forecast={forecastOn ? fc.candles : null}
            arrows={arrowMode}
            minConf={minConf}
            decimals={mk.decimals}
            footprints={g.flow.on ? g.flow.footprints : null}
            fpVersion={g.flow.version}
            footprintMode={footprintOn && !!mk.coinbase && g.flow.on}
          />
          {g.blocked && (
            <div className="absolute inset-0 z-10 grid place-items-center bg-[#0e1116] p-6 text-center text-sm text-[#d4a72c]">
              <p className="max-w-md">{g.blocked}</p>
            </div>
          )}
          {g.status === "loading" && (
            <div
              className={`absolute inset-0 grid place-items-center text-sm ${MUTED}`}
            >
              Loading {mk.label.toLowerCase()} history…
            </div>
          )}
        </div>

        <aside className="flex flex-col gap-6 overflow-auto border-t border-[#262c36] bg-[#161b22] p-4 md:border-l md:border-t-0">
          <div className="rounded-xl bg-[#1f252e] p-4 text-center">
            <div className={`text-xs uppercase tracking-wider ${MUTED}`}>
              {isForming ? "This candle" : "Next candle"}
              {closesAt ? ` · closes ${time(closesAt)}` : ""}
              {secsLeft !== null
                ? ` · ${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")} left`
                : ""}
            </div>
            <div className={`my-1 text-3xl font-bold ${bigCls}`}>{big}</div>
            <div className="text-lg tabular-nums">
              {prob == null ? "—" : `${pct(prob)} chance green`}
              {lv && <span className={`ml-1 text-xs ${MUTED}`}>live</span>}
            </div>
            {lv && (
              <>
                <div className="mx-auto mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#ef5350]/40">
                  <div
                    className="h-full bg-[#26a69a] transition-[width] duration-300"
                    style={{ width: `${lv.pGreen * 100}%` }}
                  />
                </div>
                <div className="mt-2 text-sm tabular-nums">
                  <span
                    className={lv.move > 0 ? GREEN : lv.move < 0 ? RED : MUTED}
                  >
                    {lv.move >= 0 ? "+" : ""}
                    {lv.move.toFixed(mk.decimals)} so far
                  </span>
                  {lv.move !== 0 && (
                    <span className={MUTED}>
                      {" "}
                      · currently {lv.move > 0 ? "green" : "red"}
                    </span>
                  )}
                </div>
                {g.flip.pFlip !== null &&
                  g.flip.at !== null &&
                  Date.now() - g.flip.at < 20_000 &&
                  lv.move !== 0 && (
                    <div className="mt-1 text-sm tabular-nums">
                      Jev:{" "}
                      <span
                        className={g.flip.pFlip >= 0.5 ? "text-[#d4a72c]" : ""}
                      >
                        {pct(g.flip.pFlip, 0)} chance it flips
                      </span>
                      {lv.pMath != null && (
                        <span className={`text-xs ${MUTED}`}>
                          {" "}
                          · math alone{" "}
                          {pct(lv.move > 0 ? 1 - lv.pMath : lv.pMath, 0)}
                        </span>
                      )}
                    </div>
                  )}
              </>
            )}
            {arrowMode === "minute" &&
              g.forming &&
              callMinute !== null &&
              (() => {
                const f = g.forming!;
                const read = mn.now && mn.now.time === f.time ? mn.now : null;
                const elapsed = Date.now() / 1000 - f.time;
                const due = callMinute * 60 - elapsed;
                const clock = (sec: number) =>
                  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
                return (
                  <div className="mt-3 rounded-lg border border-[#d4a72c]/50 px-3 py-2">
                    <div
                      className={`text-xs uppercase tracking-wider ${MUTED}`}
                    >
                      Jev at {readLabel(callMinute)}
                    </div>
                    {read ? (
                      <>
                        <div
                          className={`text-xl font-bold ${read.pJev > 0.5 ? GREEN : read.pJev < 0.5 ? RED : MUTED}`}
                        >
                          {read.pJev > 0.5
                            ? "GREEN"
                            : read.pJev < 0.5
                              ? "RED"
                              : "NO CALL"}{" "}
                          <span className="text-base font-semibold">
                            {pct(Math.max(read.pJev, 1 - read.pJev), 0)}
                          </span>
                        </div>
                        <div className={`text-xs ${MUTED}`}>
                          It was {read.move > 0 ? "green" : "red"} at{" "}
                          {readLabel(callMinute)}
                          {read.pJev > 0.5 !== read.move > 0
                            ? " · Jev is calling a flip"
                            : " · Jev says it holds"}
                        </div>
                      </>
                    ) : due > 0 ? (
                      <div className="text-sm">
                        Reads this candle in {clock(due)}
                      </div>
                    ) : due > -45 ? (
                      <div className="text-sm">Reading now…</div>
                    ) : (
                      <div className={`text-xs ${MUTED}`}>
                        {/error/.test(mn.status)
                          ? mn.status
                          : `No read for this candle (the page wasn't open at ${readLabel(callMinute)}, or the backend isn't deployed). Next read: ${readLabel(callMinute)} into the next candle.`}
                      </div>
                    )}
                  </div>
                );
              })()}
            <div className={`mt-2 text-xs tabular-nums ${MUTED}`}>
              {lv ? (
                <>
                  At the open:{" "}
                  <span
                    className={
                      openDir === "green" ? GREEN : openDir === "red" ? RED : ""
                    }
                  >
                    {openDir === "none" ? "no call" : openDir}
                  </span>{" "}
                  {pct(p?.pFinal, 0)} ·{" "}
                </>
              ) : null}
              Model {pct(p?.pModel, 0)}
              {p?.jev ? ` · Jev ${pct(p.jev.pGreen, 0)}` : ""}
              {p?.jev && g.refine.pNow != null
                ? ` · refined ${pct(g.refine.pNow, 0)}`
                : ""}
            </div>
            {p?.jev && p.jev.support !== null && modelDir && (
              <div
                className={`mt-1 text-xs ${p.blockedByCheck ? "text-[#d4a72c]" : MUTED}`}
              >
                Jev's fact-check of the model's {modelDir} call: the evidence{" "}
                {
                  SUPPORT_WORDS[
                    Math.round(Math.min(3, Math.max(0, p.jev.support)))
                  ]
                }{" "}
                ({p.jev.support.toFixed(1)}/3)
                {p.blockedByCheck ? " → no call" : ""}
              </div>
            )}
          </div>

          <section>
            <Label>How accurate is it?</Label>
            <p className={`mb-2 text-xs ${MUTED}`}>
              Tested on past candles, each predicted before it happened:
            </p>
            <RecordTable>
              <Row
                name="Model"
                r={g.walkForward}
                note={`${g.walkForward?.n.toLocaleString() ?? 0} candles`}
              />
              {g.backfill && (
                <>
                  <Row
                    name="Model"
                    r={g.backfill.model}
                    note={`last ${BACKFILL}`}
                  />
                  <Row
                    name="Jev"
                    r={g.backfill.jev}
                    note={`last ${BACKFILL}`}
                  />
                  <Row
                    name="Final"
                    r={g.backfill.final}
                    note={`last ${BACKFILL}`}
                  />
                </>
              )}
            </RecordTable>
            {g.liveRecord && g.liveRecord.model.n > 0 && (
              <>
                <p className={`mb-2 mt-4 text-xs ${MUTED}`}>
                  Live, since this page opened:
                </p>
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
                  Read partway through each candle. Counts only candles that
                  changed color after the read. A read "says flip" when it gives
                  the flip more than 50%.
                </p>
                {g.flip.backfill && (
                  <FlipTable rec={g.flip.backfill} where="Past candles" />
                )}
                {g.flip.live && g.flip.live.n > 0 && (
                  <FlipTable
                    rec={g.flip.live}
                    where="Live, one read per candle at halfway"
                  />
                )}
              </>
            )}
            <p className={`mt-3 text-xs ${MUTED}`}>
              The open forecast (Model, Jev, Final) is made before the candle
              starts; the live % also uses what the candle has done so far, so
              it naturally gets more certain as the candle runs. Right = share
              of calls that were correct. A call needs at least 55% one way;
              Final also needs Jev's fact-check to score {SUPPORT_NEEDED}+ of 3.
              Skill above 0 means the forecasts carry real information beyond
              the base rate; at or below 0 there's no edge, whatever the hit
              rate looks like. Expect small numbers: {tfMin}-minute{" "}
              {mk.label.toLowerCase()} is close to a coin flip.
            </p>
          </section>

          <section>
            <Label>Jev</Label>
            <p
              className={`text-sm ${g.jev.status.startsWith("error") || g.jev.status.startsWith("waiting") ? "text-[#d4a72c]" : MUTED}`}
            >
              {g.jev.status === "ok" ? "Checking each candle." : g.jev.status}
            </p>
            {g.jev.on && (
              <p className={`mt-1 text-xs ${MUTED}`}>
                Each candle, Jev makes its own call (without seeing the model)
                from the recent candles and signals, the bigger trend, key
                levels (day and 24h highs/lows, round numbers), volatility,
                hourly and 4-hour candles and, for bitcoin, Coinbase volume.
                Separately, it fact-checks the model's call. {g.jev.calls} Jev
                calls this session
                {g.trust
                  ? ` · weight in the blend: Jev ${g.trust.jev.toFixed(2)}, model ${g.trust.model.toFixed(2)}`
                  : ""}
                .
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
                  <span className={MUTED}>
                    {" "}
                    {pct(fc.endsHigherPct, 0)} of those 50 ended higher after 5
                    candles.
                  </span>
                )}
              </p>
              {fc.status !== "ok" && (
                <p
                  className={`mt-1 text-xs ${/couldn|waiting/.test(fc.status) ? "text-[#d4a72c]" : MUTED}`}
                >
                  {fc.status}
                </p>
              )}
              {(fc.replay || fc.live) && (
                <table className="mt-3 w-full text-sm tabular-nums">
                  <thead>
                    <tr className={`text-xs ${MUTED}`}>
                      <th className="pb-1 text-left font-medium"></th>
                      <th className="pb-1 text-right font-medium">
                        1st bar color
                      </th>
                      <th className="pb-1 text-right font-medium">
                        Direction at 5
                      </th>
                      <th className="pb-1 text-right font-medium">n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fc.replay && (
                      <PathRow name="Typical" r={fc.replay} note="past 200" />
                    )}
                    {fc.live && fc.live.typical.end.n > 0 && (
                      <PathRow name="Typical" r={fc.live.typical} note="live" />
                    )}
                    {fc.live && fc.live.jev.end.n > 0 && (
                      <PathRow name="Jev's pick" r={fc.live.jev} note="live" />
                    )}
                  </tbody>
                </table>
              )}
              <p className={`mt-2 text-xs ${MUTED}`}>
                Faded bars on the chart. Each is something{" "}
                {mk.label.toLowerCase()} really did after a moment like this
                one, rescaled to today's volatility and redrawn at every close.
                Right % above 50 is an edge; around 50 the bars are only a
                picture of typical behaviour, not a prediction. {fc.calls} Jev
                picks this session.
              </p>
            </section>
          )}

          <section>
            <Label>Jev refined</Label>
            <div className="mb-2 flex overflow-hidden rounded-md border border-[#262c36] text-xs">
              {(["jev", "refined", "minute"] as const)
                .filter((m) => m !== "minute" || callMinute !== null)
                .map((m) => (
                  <button
                    key={m}
                    onClick={() => setArrows(m)}
                    className={`flex-1 px-2 py-1 ${arrowMode === m ? "bg-[#d4a72c] font-semibold text-[#0e1116]" : "text-[#8b949e] hover:bg-[#1f252e]"}`}
                  >
                    {m === "jev"
                      ? "Jev"
                      : m === "refined"
                        ? "Refined"
                        : `Jev at ${readShort(callMinute!)}`}
                  </button>
                ))}
            </div>
            {arrowMode === "minute" && (
              <div className="mb-3 rounded-md border border-[#262c36] p-2">
                <div className="mb-2 flex items-center gap-1 text-xs">
                  <span className={MUTED}>Read the candle at</span>
                  {minuteOpts.map((m) => (
                    <button
                      key={m}
                      onClick={() => setMinutePick(m)}
                      className={`rounded px-2 py-0.5 ${m === callMinute ? "bg-[#d4a72c] font-semibold text-[#0e1116]" : "text-[#8b949e] hover:bg-[#1f252e]"}`}
                    >
                      {readShort(m)}
                    </button>
                  ))}
                </div>
                {mn.status !== "ok" && (
                  <p
                    className={`mb-2 text-xs ${/error|needs|not /.test(mn.status) ? "text-[#d4a72c]" : MUTED}`}
                  >
                    {mn.status}
                  </p>
                )}
                {(mn.past || mn.live.holds.n > 0) && (
                  <table className="w-full text-sm tabular-nums">
                    <thead>
                      <tr className={`text-xs ${MUTED}`}>
                        <th className="pb-1 text-left font-medium">
                          Right at close
                        </th>
                        <th className="pb-1 text-right font-medium">Past</th>
                        <th className="pb-1 text-right font-medium">Live</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          ["Jev", "jev"],
                          ["Current color holds", "holds"],
                          ["Math", "math"],
                          ["Jev, when it calls a flip", "jevFlips"],
                        ] as const
                      ).map(([name, k]) => {
                        const cell = (
                          sc: { right: number; n: number } | undefined,
                        ) =>
                          sc && sc.n ? (
                            <>
                              {pct(sc.right / sc.n, 0)}{" "}
                              <span className={`text-xs ${MUTED}`}>
                                ({sc.n})
                              </span>
                            </>
                          ) : (
                            "—"
                          );
                        return (
                          <tr key={k} className="border-t border-[#262c36]">
                            <td className="py-1.5 text-left">{name}</td>
                            <td className="py-1.5 text-right">
                              {cell(mn.past?.[k])}
                            </td>
                            <td className="py-1.5 text-right">
                              {cell(mn.live[k])}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {byConf.some((r) => r.n > 0) && (
                  <>
                    <p className={`mb-1 mt-3 text-xs ${MUTED}`}>
                      Right at close, by how sure Jev was at{" "}
                      {readLabel(callMinute!)} (same candles: what "current
                      color holds" scored):
                    </p>
                    <table className="w-full text-sm tabular-nums">
                      <thead>
                        <tr className={`text-xs ${MUTED}`}>
                          <th className="pb-1 text-left font-medium">
                            Jev said
                          </th>
                          <th className="pb-1 text-right font-medium">
                            Jev right
                          </th>
                          <th className="pb-1 text-right font-medium">
                            Holds right
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {byConf.map((r) => (
                          <tr
                            key={r.label}
                            className="border-t border-[#262c36]"
                          >
                            <td className="py-1.5 text-left">{r.label}</td>
                            <td
                              className={`py-1.5 text-right ${r.n >= 15 ? (r.jev > r.holds + 0.03 ? GREEN : r.jev < r.holds - 0.03 ? RED : "") : ""}`}
                            >
                              {r.n ? (
                                <>
                                  {pct(r.jev, 0)}{" "}
                                  <span className={`text-xs ${MUTED}`}>
                                    ({r.n})
                                  </span>
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="py-1.5 text-right">
                              {r.n ? pct(r.holds, 0) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className={`mt-1 text-xs ${MUTED}`}>
                      Green = Jev beat "holds" in that band (15+ candles), red =
                      it did worse. A band where Jev is right about as often as
                      it says (e.g. ~85% in 80–90%) is well calibrated.
                    </p>
                  </>
                )}
                <p className={`mt-2 text-xs ${MUTED}`}>
                  Jev reads the candle{" "}
                  {callMinute! < 1
                    ? `${Math.round(callMinute! * 60)} seconds`
                    : `${callMinute} minute${callMinute === 1 ? "" : "s"}`}{" "}
                  after it opens (moves, high/low, pullback, time left, last 3
                  candles) and calls its final color.
                  {mn.past &&
                    mn.past.flipped.n > 0 &&
                    ` On past candles, ${pct(mn.past.flipped.right / mn.past.flipped.n, 0)} changed color after ${readLabel(callMinute!)}, so "current color holds" is right ${pct(1 - mn.past.flipped.right / mn.past.flipped.n, 0)} of the time.`}{" "}
                  Jev only adds something if it beats that row, which shows up
                  in "when it calls a flip" being well above 50%.
                  {` ${mn.calls} Jev calls for this.`}
                </p>
              </div>
            )}
            <p className={`mb-1 text-xs ${MUTED}`}>
              Only show arrows this sure (leaves coin-flip candles blank):
            </p>
            <table className="mb-3 w-full text-sm tabular-nums">
              <thead>
                <tr className={`text-xs ${MUTED}`}>
                  <th className="pb-1 text-left font-medium">Sure at least</th>
                  {cols.map(([, label]) => (
                    <th key={label} className="pb-1 text-right font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(arrowMode === "minute"
                  ? [0.5, 0.6, 0.7, 0.8, 0.9]
                  : [0.5, 0.55, 0.58, 0.6, 0.65]
                ).map((t) => {
                  const cell = (src: ArrowMode) => {
                    const r = tallyAt(src, t);
                    return r.n ? (
                      <span
                        className={
                          r.n >= 20 && r.right / r.n >= 0.6 ? GREEN : ""
                        }
                      >
                        {pct(r.right / r.n, 0)}{" "}
                        <span className={`text-xs ${MUTED}`}>({r.n})</span>
                      </span>
                    ) : (
                      "—"
                    );
                  };
                  return (
                    <tr
                      key={t}
                      onClick={() => setMinConf(t)}
                      className={`cursor-pointer border-t border-[#262c36] ${t === minConf ? "bg-[#1f252e]" : "hover:bg-[#1f252e]"}`}
                    >
                      <td className="py-1.5 text-left">
                        {t === 0.5 ? "every call" : `${Math.round(t * 100)}%`}
                        {t === minConf ? " ◀" : ""}
                      </td>
                      {cols.map(([src]) => (
                        <td key={src} className="py-1.5 text-right">
                          {cell(src)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {g.refine.past || g.refine.live.raw.n > 0 ? (
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className={`text-xs ${MUTED}`}>
                    <th className="pb-1 text-left font-medium"></th>
                    <th className="pb-1 text-right font-medium">Jev</th>
                    <th className="pb-1 text-right font-medium">Refined</th>
                    <th className="pb-1 text-right font-medium">n</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Past candles", g.refine.past],
                    ["Live", g.refine.live.raw.n > 0 ? g.refine.live : null],
                  ].map(([name, r]) =>
                    r && typeof r === "object" ? (
                      <tr
                        key={name as string}
                        className="border-t border-[#262c36]"
                      >
                        <td className="py-1.5 text-left">{name as string}</td>
                        <td className="py-1.5 text-right">
                          {r.raw.n ? pct(r.raw.right / r.raw.n, 1) : "—"}
                        </td>
                        <td
                          className={`py-1.5 text-right ${r.fixed.n && r.raw.n ? (r.fixed.right / r.fixed.n > r.raw.right / r.raw.n ? GREEN : r.fixed.right / r.fixed.n < r.raw.right / r.raw.n ? RED : "") : ""}`}
                        >
                          {r.fixed.n ? pct(r.fixed.right / r.fixed.n, 1) : "—"}
                        </td>
                        <td className="py-1.5 text-right">{r.raw.n}</td>
                      </tr>
                    ) : null,
                  )}
                </tbody>
              </table>
            ) : (
              <p className={`text-sm ${MUTED}`}>
                Waiting for Jev's past-candle check…
              </p>
            )}
            {g.refine.learned && (
              <p className={`mt-2 text-xs ${MUTED}`}>
                Learned from {g.refine.updates} of Jev's calls:{" "}
                {Math.abs(g.refine.learned.bias) < 0.05
                  ? "no overall lean"
                  : g.refine.learned.bias < 0
                    ? "Jev leans too bullish (nudged toward red)"
                    : "Jev leans too bearish (nudged toward green)"}
                {" · "}
                {Math.abs(g.refine.learned.confidence - 1) < 0.05
                  ? "confidence about right"
                  : g.refine.learned.confidence < 0
                    ? "Jev has been backwards lately, so its calls are flipped"
                    : g.refine.learned.confidence < 1
                      ? `Jev overconfident (its edge × ${g.refine.learned.confidence.toFixed(2)})`
                      : `Jev underconfident (its edge × ${g.refine.learned.confidence.toFixed(2)})`}
                {g.refine.learned.situations.length > 0 &&
                  ` · biggest situation fixes: ${g.refine.learned.situations.map((x) => `${x.name} (${x.weight > 0 ? "→ green" : "→ red"})`).join(", ")}`}
                .
              </p>
            )}
            <p className={`mt-2 text-xs ${MUTED}`}>
              Right % of the 50% arrows. Refined adjusts Jev's % using its own
              wins and losses (walk-forward: each candle is read before it's
              learned from). It also sees the bigger trend (last 20 and 50
              candles, a longer average), so it can learn things like "Jev's red
              calls lose in an uptrend". It starts by trusting Jev and adapts
              within tens of candles. No extra Jev calls.
            </p>
          </section>

          <section>
            <Label>Jev flip check</Label>
            <p
              className={`text-sm ${g.flip.status.startsWith("error") || g.flip.status.startsWith("waiting") ? "text-[#d4a72c]" : MUTED}`}
            >
              {g.flip.status === "ok"
                ? "Reading the forming candle every 3 seconds (when it has changed)."
                : g.flip.status}
            </p>
            <p className={`mt-1 text-xs ${MUTED}`}>
              While a candle forms, Jev sees how far it has moved, its high/low,
              how much it has pulled back, the time left and the last 3 candles
              (sizes only, no prices) and answers one question: does it hold its
              color or flip? The live % blends that with the math, weighted by
              how each scored on past candles rebuilt partway through from
              1-minute data.
              {` ${g.flip.calls} flip calls this session`}
              {g.flip.weights
                ? ` · weight: Jev ${g.flip.weights.jev.toFixed(2)}, math ${g.flip.weights.math.toFixed(2)}`
                : ""}
              .
            </p>
          </section>

          {g.source !== "Simulated" && (
            <section>
              <Label>Live ticks</Label>
              {mk.coinbase && g.flow.status && (
                <p
                  className={`mb-1 text-xs ${/couldn|too many|disconnect/.test(g.flow.status) ? "text-[#d4a72c]" : MUTED}`}
                >
                  Order flow (Coinbase {mk.coinbase} trades): {g.flow.status}.
                  Jev sees who was aggressive (buyers vs sellers) in recent
                  candles; footprints show it per price level. Zoom in to read
                  the numbers.
                </p>
              )}
              <p
                className={`text-sm ${g.ticks.state === "fallback" ? "text-[#d4a72c]" : MUTED}`}
              >
                {g.ticks.state === "streaming"
                  ? g.ticks.source && g.ticks.source !== "Pyth"
                    ? `Streaming the ${mk.indexName ?? g.ticks.source} (${g.ticks.source}) via Kalshi${g.ticks.note?.includes("5hz") ? ", up to 5 values a second" : ", once a second"}.`
                    : "Streaming every Pyth price update."
                  : g.ticks.state === "connecting"
                    ? "Connecting to the tick stream…"
                    : `Not streaming (${g.ticks.detail}). The candle updates from 1-minute data every few seconds instead.`}
              </p>
              {mk.index && g.ticks.source !== mk.index && g.ticks.note && (
                <p className="mt-1 text-xs text-[#d4a72c]">
                  {g.ticks.note}.{" "}
                  {/not set/.test(g.ticks.note)
                    ? `To use ${mk.index}, create a Kalshi API key and add its ID and private key as the backend secrets KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY.`
                    : ""}
                </p>
              )}
              {mk.index && (
                <p className={`mt-1 text-xs ${MUTED}`}>
                  Past candles (and the model's training) come from Pyth{" "}
                  {mk.pair.split(" ")[0]}, which tracks {mk.index} closely;
                  candles streamed live from {mk.index} are kept as {mk.index}.
                </p>
              )}
              {g.ticks.state === "fallback" && g.ticks.check && (
                <div className={`mt-1 text-xs ${MUTED}`}>
                  {g.ticks.check.ok ? (
                    <>
                      Backend test: the stream works ({g.ticks.check.host},
                      first price {g.ticks.check.firstPrice?.toFixed(2)}), so
                      the problem is between the backend and this page. Reload;
                      if it persists, tell Claude.
                    </>
                  ) : (
                    <>
                      Backend test: {g.ticks.check.problems.join(" · ")}
                      {g.ticks.check.feedSource === "fallback"
                        ? ` (couldn't look up the ${mk.label.toLowerCase()} feed; tried the standard feed id)`
                        : ""}
                      .
                      {g.ticks.check.problems.some((x) =>
                        /401|403|unauthor|forbidden/i.test(x),
                      )
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
            Arrows are {arrows === "refined" ? "Jev's refined" : "Jev's own"}{" "}
            call on each candle (made before it opened): up = above 50% chance
            green, down = below 50%. Colored = right, gray = wrong.
            {jevArrows.n > 0 &&
              ` Arrows on screen: ${jevArrows.right} of ${jevArrows.n} right (${pct(jevArrows.right / jevArrows.n, 1)}).`}{" "}
            Trained on {g.trainedOn.toLocaleString()} candles.
          </p>
        </aside>
      </main>
    </div>
  );
}
