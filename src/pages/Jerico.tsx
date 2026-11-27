import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchJerico, type JericoData } from "@/gold/feed";
import { type Chunk, decode, type Side } from "@/gold/jerico";
import JericoChart from "@/gold/JericoChart";

/** /jerico — the 5-minute BTC Up/Down market on Polymarket, rebuilt tick by tick from the recorder. */
const card = "rounded-lg border border-[#30363d] bg-[#161b22] p-4";
const hhmm = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const btn = (on: boolean) =>
  `rounded border px-2 py-1 text-xs ${on ? "border-[#58a6ff] bg-[#1f2a3a] text-[#c9d1d9]" : "border-[#30363d] text-[#8b949e] hover:bg-[#21262d]"}`;

const Jerico = () => {
  const [sel, setSel] = useState<number | null>(null); // null = live
  const [data, setData] = useState<Omit<JericoData, "chunks"> | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [windows, setWindows] = useState<JericoData["windows"]>([]);
  const [view, setView] = useState<Side>("up");
  const [mode, setMode] = useState<"ticks" | "candles">("ticks");
  const [bucket, setBucket] = useState(5000);
  const [zoom, setZoom] = useState<"all" | "60" | "15">("all");
  const [err, setErr] = useState<string | null>(null);
  const lastSeq = useRef<number>(-1);
  const shownWindow = useRef<number | null>(null);

  useEffect(() => {
    document.title = "Jerico";
  }, []);

  // Load the chosen window; while live, fetch only new chunks every 2 s (and start over when the window rolls).
  useEffect(() => {
    let alive = true;
    lastSeq.current = -1;
    shownWindow.current = null;
    setChunks([]);
    const load = async (first: boolean) => {
      const d = await fetchJerico({
        window: sel,
        since: first || sel !== null ? null : lastSeq.current,
        list: first,
      });
      if (!alive) return;
      if (!d) {
        setErr("Can't reach the bot (deploy the fadebot edge function).");
        return;
      }
      setErr(null);
      if (d.windows.length) setWindows(d.windows);
      const rolled = shownWindow.current !== null && shownWindow.current !== d.window;
      shownWindow.current = d.window;
      const { chunks: cs, ...rest } = d;
      setData(rest);
      if (first || rolled) {
        lastSeq.current = cs.length ? cs[cs.length - 1].seq : -1;
        setChunks(cs);
        if (rolled && !cs.length) lastSeq.current = -1;
      } else if (cs.length) {
        lastSeq.current = cs[cs.length - 1].seq;
        setChunks((old) => [...old, ...cs]);
      }
    };
    void load(true);
    const id = sel === null
      ? setInterval(() => {
        if (document.visibilityState === "visible") void load(false);
      }, 2000)
      : undefined;
    const lid = setInterval(() => void fetchJerico({ window: sel, since: 1e9, list: true }).then((d) => d && alive && setWindows(d.windows)), 30_000);
    return () => {
      alive = false;
      if (id) clearInterval(id);
      clearInterval(lid);
    };
  }, [sel]);

  const longIs = (data?.longIs ?? "up") as Side;
  const { book, trades } = useMemo(() => decode(chunks, longIs, view), [chunks, longIs, view]);
  const ws = (data?.window ?? 0) * 1000;
  const nowMs = data?.live ? Date.now() : null;
  const lastT = Math.max(book[book.length - 1]?.t ?? ws, trades[trades.length - 1]?.t ?? ws);
  const to = zoom === "all" ? ws + 300_000 : Math.max(lastT, nowMs ?? 0, ws + 1000);
  const from = zoom === "all" ? ws : Math.max(ws, to - Number(zoom) * 1000);

  const last = book[book.length - 1];
  const bought = trades.reduce((a, x) => a + (x.takerBought ? x.qty : 0), 0);
  const sold = trades.reduce((a, x) => a + (x.takerBought ? 0 : x.qty), 0);
  const mids = book.map((b) => (b.bid + b.ask) / 2);
  const left = data?.live ? Math.max(0, Math.round(data.window + 300 - Date.now() / 1000)) : null;

  return (
    <main className="min-h-screen bg-[#0e1116] px-4 py-6 text-[#c9d1d9]">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">Jerico</h1>
          <span className="text-xs text-[#8b949e]">
            <Link to="/pump" className="mr-3 underline">Pump bot</Link>
            BTC 5-minute Up/Down on Polymarket, every tick {data?.slug ? `· ${data.slug}` : ""}
          </span>
        </header>

        <section className={`${card} flex flex-wrap items-center gap-2`}>
          <select
            className="rounded border border-[#30363d] bg-[#0e1116] px-2 py-1 text-xs"
            value={sel ?? "live"}
            onChange={(e) => setSel(e.target.value === "live" ? null : Number(e.target.value))}
          >
            <option value="live">Live (current window)</option>
            {windows.map((w) => (
              <option key={w.start} value={w.start}>
                {hhmm(w.start)}–{hhmm(w.start + 300)} · {w.ticks.toLocaleString()} ticks
              </option>
            ))}
          </select>
          <span className="mx-1 text-[#30363d]">|</span>
          <button className={btn(view === "up")} onClick={() => setView("up")}>Up</button>
          <button className={btn(view === "down")} onClick={() => setView("down")}>Down</button>
          <span className="mx-1 text-[#30363d]">|</span>
          <button className={btn(mode === "ticks")} onClick={() => setMode("ticks")}>Ticks</button>
          <button className={btn(mode === "candles")} onClick={() => setMode("candles")}>Candles</button>
          {mode === "candles"
            ? [1000, 5000, 15000, 30000].map((b) => (
              <button key={b} className={btn(bucket === b)} onClick={() => setBucket(b)}>{b / 1000}s</button>
            ))
            : null}
          <span className="mx-1 text-[#30363d]">|</span>
          <button className={btn(zoom === "all")} onClick={() => setZoom("all")}>Whole window</button>
          <button className={btn(zoom === "60")} onClick={() => setZoom("60")}>Last 60 s</button>
          <button className={btn(zoom === "15")} onClick={() => setZoom("15")}>Last 15 s</button>
        </section>

        {err ? <p className="text-sm text-[#ef5350]">{err}</p> : null}

        <section className={card}>
          <div className="mb-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-6">
            <div>
              <div className="text-xs text-[#8b949e]">{view === "up" ? "Up" : "Down"} bid / ask</div>
              <div className="tabular-nums font-medium">
                {last ? `${(last.bid * 100).toFixed(1)} / ${(last.ask * 100).toFixed(1)}¢` : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Mid high / low</div>
              <div className="tabular-nums">
                {mids.length ? `${(Math.max(...mids) * 100).toFixed(1)} / ${(Math.min(...mids) * 100).toFixed(1)}¢` : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Book ticks</div>
              <div className="tabular-nums">{book.length.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Trades</div>
              <div className="tabular-nums">{trades.length.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">Aggressive buys / sells</div>
              <div className="tabular-nums">
                <span className="text-[#26a69a]">{Math.round(bought)}</span> / <span className="text-[#ef5350]">{Math.round(sold)}</span> sh
              </div>
            </div>
            <div>
              <div className="text-xs text-[#8b949e]">{data?.live ? "Time left" : "Window"}</div>
              <div className="tabular-nums">
                {data ? (left !== null ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : `${hhmm(data.window)}–${hhmm(data.window + 300)}`) : "—"}
              </div>
            </div>
          </div>
          {data ? (
            <JericoChart book={book} trades={trades} windowStart={ws} from={from} to={to} mode={mode} bucketMs={bucket} nowMs={nowMs} />
          ) : (
            <p className="text-xs text-[#8b949e]">Loading…</p>
          )}
          <p className="mt-2 text-[11px] text-[#8b949e]">
            Green/red lines: best bid/ask (band = spread), white: mid. Bubbles: trades, sized by shares — green = the aggressor
            bought {view === "up" ? "Up" : "Down"}, red = sold it. Bottom: aggressive buys vs sells, yellow = cumulative delta.
            Hover for the exact tick. Recorded from the Polymarket websocket by the bot's cron (about 2 s a minute between runs isn't covered).
          </p>
        </section>
      </div>
    </main>
  );
};

export default Jerico;
