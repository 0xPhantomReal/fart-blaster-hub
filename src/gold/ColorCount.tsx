import { useState } from "react";

const MUTED = "text-[#8b949e]";
const GREEN = "text-[#26a69a]";
const RED = "text-[#ef5350]";
const WINDOWS = [1, 4, 12, 24] as const;

type C = { time: number; open: number; close: number };

/** Green vs red closed candles over the last few hours, on the chart's own candles. */
export function ColorCount({ candles, tfMin }: { candles: C[]; tfMin: number }) {
  const [hours, setHours] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("gold.countHours"));
      return (WINDOWS as readonly number[]).includes(v) ? v : 4;
    } catch {
      return 4;
    }
  });
  const pick = (h: number) => {
    setHours(h);
    try {
      localStorage.setItem("gold.countHours", String(h));
    } catch {
      // per-visit only
    }
  };
  const now = Date.now() / 1000;
  const tf = tfMin * 60;
  // Closed candles that opened within the window.
  const list = candles.filter((c) => c.time >= now - hours * 3600 && c.time + tf <= now);
  const green = list.filter((c) => c.close > c.open).length;
  const red = list.filter((c) => c.close < c.open).length;
  const flat = list.length - green - red;
  // Current run of one color (from the latest closed candle back).
  let run = 0;
  let runColor: "green" | "red" | null = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i].close > list[i].open ? "green" : list[i].close < list[i].open ? "red" : null;
    if (!c) break;
    if (runColor && c !== runColor) break;
    runColor = c;
    run += 1;
  }
  const share = (n: number) => (list.length ? `${Math.round((n / list.length) * 100)}%` : "—");
  return (
    <div className="mb-3 rounded-md border border-[#262c36] p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className={MUTED}>Candle colors, last</span>
        <div className="flex gap-1">
          {WINDOWS.map((h) => (
            <button
              key={h}
              onClick={() => pick(h)}
              className={`rounded px-1.5 py-0.5 ${h === hours ? "bg-[#262c36] text-white" : MUTED}`}
            >
              {h}h
            </button>
          ))}
        </div>
      </div>
      <div className="tabular-nums">
        <span className={`font-bold ${GREEN}`}>{green} green</span> ({share(green)}) ·{" "}
        <span className={`font-bold ${RED}`}>{red} red</span> ({share(red)})
        {flat ? <span className={MUTED}> · {flat} flat</span> : null}
        <span className={MUTED}> · {list.length} candles</span>
      </div>
      {runColor && (
        <div className={MUTED}>
          Latest run: {run} {runColor} in a row
        </div>
      )}
    </div>
  );
}
