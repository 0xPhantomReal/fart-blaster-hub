import { useEffect, useState } from "react";
import { GoldChart } from "@/gold/GoldChart";
import { TIMEFRAME_MIN } from "@/gold/feed";
import { SUPPORT_NEEDED, type TrackRecord } from "@/gold/predictor";
import { BACKFILL, useGold } from "@/gold/useGold";

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

const Label = ({ children }: { children: React.ReactNode }) => (
  <h2 className={`mb-2 text-xs font-semibold uppercase tracking-wider ${MUTED}`}>{children}</h2>
);

export default function Gold() {
  const g = useGold();
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
  const tf = TIMEFRAME_MIN * 60;
  const isForming = !!(p && g.forming && g.forming.time === p.forTime);
  const closesAt = p ? p.forTime + tf : null;
  const secsLeft = closesAt && g.source !== "Simulated" ? Math.max(0, Math.round(closesAt - Date.now() / 1000)) : null;

  const dir = p?.call === 1 ? "green" : p?.call === -1 ? "red" : "none";
  const big = !p ? "—" : dir === "none" ? "NO CALL" : dir.toUpperCase();
  const bigCls = dir === "green" ? GREEN : dir === "red" ? RED : MUTED;
  const modelDir = p?.modelCall === 1 ? "green" : p?.modelCall === -1 ? "red" : null;

  return (
    <div className="flex h-[100dvh] flex-col bg-[#0e1116] text-[#e6e8eb] [font-family:ui-sans-serif,system-ui,-apple-system,'Segoe_UI',sans-serif] [&_h1]:[font-family:inherit] [&_h2]:[font-family:inherit]">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-[#262c36] px-4 py-3">
        <h1 className="text-base font-semibold">
          <span className="text-[#d4a72c]">XAU/USD</span> · <span className="text-[#d4a72c]">{TIMEFRAME_MIN}m</span>
        </h1>
        <div className={`text-lg font-semibold tabular-nums ${last && last.close < last.open ? RED : GREEN}`}>{last ? last.close.toFixed(2) : "—"}</div>
        <div className={`ml-auto text-xs ${g.source === "Simulated" ? "text-[#d4a72c]" : MUTED}`}>
          {g.status === "loading" ? "loading…" : g.source === "Simulated" ? "SIMULATED DATA" : "Pyth live"}
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[56vh_auto] md:grid-cols-[1fr_320px] md:grid-rows-1">
        <div className="relative min-h-0">
          <GoldChart bars={g.bars} forming={g.forming} version={g.version} />
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
            <div className="tabular-nums">{p?.pFinal == null ? "—" : `${pct(p.pFinal)} chance green`}</div>
            <div className={`mt-2 text-xs tabular-nums ${MUTED}`}>
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
            {g.live && g.live.model.n > 0 && (
              <>
                <p className={`mb-2 mt-4 text-xs ${MUTED}`}>Live, since this page opened:</p>
                <RecordTable>
                  <Row name="Model" r={g.live.model} />
                  {g.jev.on && <Row name="Jev" r={g.live.jev} />}
                  <Row name="Final" r={g.live.final} />
                </RecordTable>
              </>
            )}
            <p className={`mt-3 text-xs ${MUTED}`}>
              Right = share of calls that were correct. A call needs at least 55% one way; Final also needs Jev's fact-check to
              score {SUPPORT_NEEDED}+ of 3. Skill above 0 means the forecasts carry real information beyond the base rate; at or
              below 0 there's no edge, whatever the hit rate looks like. Expect small numbers: 15-minute gold is close to a coin
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

          {g.error && <p className="text-xs text-[#d4a72c]">{g.error}</p>}
          <p className={`text-xs ${MUTED}`}>
            Arrows mark candles a call was made for: colored = right, gray = wrong. Trained on {g.trainedOn.toLocaleString()} candles.
          </p>
        </aside>
      </main>
    </div>
  );
}
