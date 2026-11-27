import { useEffect, useRef, useState } from "react";
import { type BookTick, type Candle, candles, flow, lastAt, type TradeTick } from "./jerico";

/**
 * Tick-by-tick chart of one 5-minute market (canvas, millisecond time axis):
 *   price panel — bid/ask band (step lines) + mid, or mid-price candles; every trade as a bubble sized by quantity,
 *                 green when the aggressor bought this side, red when they sold it
 *   flow panel  — aggressive buys (up) vs sells (down) per bucket, with cumulative delta (yellow)
 *   crosshair   — hover for the exact tick
 */
export interface JericoChartProps {
  book: BookTick[];
  trades: TradeTick[];
  windowStart: number; // ms
  from: number; // visible range, ms
  to: number;
  mode: "ticks" | "candles";
  bucketMs: number;
  nowMs: number | null; // live: draw a "now" line
}

const C = {
  bg: "#0e1116",
  grid: "#21262d",
  axis: "#8b949e",
  bid: "#26a69a",
  ask: "#ef5350",
  band: "rgba(88,166,255,0.10)",
  mid: "#c9d1d9",
  buy: "rgba(38,166,154,0.75)",
  sell: "rgba(239,83,80,0.75)",
  cvd: "#d29922",
  now: "#58a6ff",
};
const H_PRICE = 380, H_GAP = 10, H_FLOW = 110, H_AXIS = 22, PAD_R = 62, PAD_L = 6;

const mmss = (ms: number, start: number, withMs = false) => {
  const s = Math.max(0, (ms - start) / 1000);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${withMs ? sec.toFixed(3).padStart(6, "0") : String(Math.floor(sec)).padStart(2, "0")}`;
};
const niceStep = (span: number, target: number) => {
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
};

export default function JericoChart(p: JericoChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null); // ms under the cursor

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = H_PRICE + H_GAP + H_FLOW + H_AXIS;
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, w, H);

    const { book, trades, from, to } = p;
    const plotW = w - PAD_L - PAD_R;
    const X = (t: number) => PAD_L + ((t - from) / Math.max(1, to - from)) * plotW;
    const i0 = Math.max(0, lastAt(book, from));
    const vis = book.slice(i0, lastAt(book, to) + 1);
    const vTrades = trades.filter((x) => x.t >= from && x.t <= to);
    const cs: Candle[] = p.mode === "candles" ? candles(book, from, to, p.bucketMs) : [];

    // Price range from what's visible.
    let lo = 1, hi = 0;
    for (const b of vis) {
      lo = Math.min(lo, b.bid);
      hi = Math.max(hi, b.ask);
    }
    for (const x of vTrades) {
      lo = Math.min(lo, x.px);
      hi = Math.max(hi, x.px);
    }
    if (hi < lo) {
      g.fillStyle = C.axis;
      g.font = "12px ui-sans-serif, system-ui";
      g.fillText("No ticks in this range yet.", PAD_L + 10, 30);
      return;
    }
    const padY = Math.max(0.005, (hi - lo) * 0.08);
    lo = Math.max(0, lo - padY);
    hi = Math.min(1, hi + padY);
    const Y = (v: number) => 8 + (1 - (v - lo) / Math.max(1e-6, hi - lo)) * (H_PRICE - 16);

    // Grid + price labels (¢).
    g.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    const ys = niceStep((hi - lo) * 100, 6) / 100;
    for (let v = Math.ceil(lo / ys) * ys; v <= hi + 1e-9; v += ys) {
      g.strokeStyle = C.grid;
      g.beginPath();
      g.moveTo(PAD_L, Y(v));
      g.lineTo(w - PAD_R, Y(v));
      g.stroke();
      g.fillStyle = C.axis;
      g.fillText(`${(v * 100).toFixed(ys < 0.01 ? 1 : 0)}¢`, w - PAD_R + 4, Y(v) + 3);
    }
    const xs = niceStep((to - from) / 1000, 8) * 1000;
    const flowTop = H_PRICE + H_GAP, flowBot = flowTop + H_FLOW;
    for (let t = Math.ceil((from - p.windowStart) / xs) * xs + p.windowStart; t <= to; t += xs) {
      g.strokeStyle = C.grid;
      g.beginPath();
      g.moveTo(X(t), 0);
      g.lineTo(X(t), flowBot);
      g.stroke();
      g.fillStyle = C.axis;
      g.fillText(mmss(t, p.windowStart), X(t) - 12, flowBot + 15);
    }

    if (p.mode === "ticks") {
      // Spread band, then bid and ask as step lines, then the mid.
      const end = (i: number) => (i + 1 < book.length ? book[i + 1].t : Math.max(book[i].t, Math.min(to, p.nowMs ?? book[i].t)));
      for (let k = 0; k < vis.length; k++) {
        const b = vis[k], e = end(i0 + k);
        g.fillStyle = C.band;
        g.fillRect(X(Math.max(b.t, from)), Y(b.ask), Math.max(1, X(e) - X(Math.max(b.t, from))), Y(b.bid) - Y(b.ask));
      }
      const step = (pick: (b: BookTick) => number, color: string, width: number) => {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        vis.forEach((b, k) => {
          const x0 = X(Math.max(b.t, from)), x1 = X(end(i0 + k)), y = Y(pick(b));
          if (k === 0) g.moveTo(x0, y);
          else g.lineTo(x0, y);
          g.lineTo(x1, y);
        });
        g.stroke();
        g.lineWidth = 1;
      };
      step((b) => b.bid, C.bid, 1.2);
      step((b) => b.ask, C.ask, 1.2);
      step((b) => (b.bid + b.ask) / 2, C.mid, 1);
    } else {
      const bw = Math.max(1, (p.bucketMs / Math.max(1, to - from)) * plotW * 0.7);
      for (const k of cs) {
        const x = X(k.t + p.bucketMs / 2);
        const up = k.c >= k.o;
        g.strokeStyle = g.fillStyle = up ? C.bid : C.ask;
        g.beginPath();
        g.moveTo(x, Y(k.h));
        g.lineTo(x, Y(k.l));
        g.stroke();
        g.fillRect(x - bw / 2, Math.min(Y(k.o), Y(k.c)), bw, Math.max(1, Math.abs(Y(k.o) - Y(k.c))));
      }
    }

    // Trades as bubbles.
    for (const x of vTrades) {
      g.fillStyle = x.takerBought ? C.buy : C.sell;
      g.beginPath();
      g.arc(X(x.t), Y(x.px), Math.min(12, 2 + Math.sqrt(x.qty) * 0.9), 0, Math.PI * 2);
      g.fill();
    }

    // Flow panel: aggressive buys up, sells down, cumulative delta.
    const fb = flow(vTrades, p.mode === "candles" ? p.bucketMs : Math.max(1000, niceStep((to - from) / 120, 1)));
    const maxF = Math.max(1, ...fb.map((f) => Math.max(f.bought, f.sold)));
    const zero = flowTop + H_FLOW / 2;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(PAD_L, zero);
    g.lineTo(w - PAD_R, zero);
    g.stroke();
    const bucket = fb.length > 1 ? fb[1].t - fb[0].t : 1000;
    const fw = Math.max(1, (bucket / Math.max(1, to - from)) * plotW * 0.8);
    for (const f of fb) {
      const x = X(f.t);
      g.fillStyle = C.buy;
      g.fillRect(x, zero - (f.bought / maxF) * (H_FLOW / 2 - 4), fw, (f.bought / maxF) * (H_FLOW / 2 - 4));
      g.fillStyle = C.sell;
      g.fillRect(x, zero, fw, (f.sold / maxF) * (H_FLOW / 2 - 4));
    }
    let cum = 0;
    const cvd = vTrades.map((x) => ({ t: x.t, v: (cum += x.takerBought ? x.qty : -x.qty) }));
    const maxC = Math.max(1, ...cvd.map((c) => Math.abs(c.v)));
    if (cvd.length) {
      g.strokeStyle = C.cvd;
      g.beginPath();
      cvd.forEach((c, k) => {
        const y = zero - (c.v / maxC) * (H_FLOW / 2 - 4);
        if (k === 0) g.moveTo(X(c.t), y);
        else g.lineTo(X(c.t), y);
      });
      g.stroke();
    }
    g.fillStyle = C.axis;
    g.fillText(`flow ±${Math.round(maxF)} sh`, w - PAD_R + 2, flowTop + 10);
    g.fillStyle = C.cvd;
    g.fillText(`Δ ${Math.round(cum)}`, w - PAD_R + 2, flowBot - 4);

    if (p.nowMs !== null && p.nowMs >= from && p.nowMs <= to) {
      g.strokeStyle = C.now;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(X(p.nowMs), 0);
      g.lineTo(X(p.nowMs), flowBot);
      g.stroke();
      g.setLineDash([]);
    }

    // Crosshair + the exact tick under it.
    if (hover !== null && hover >= from && hover <= to) {
      const x = X(hover);
      g.strokeStyle = "#6e7681";
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, flowBot);
      g.stroke();
      const bi = lastAt(book, hover);
      const b = bi >= 0 ? book[bi] : null;
      const ti = lastAt(trades, hover);
      const tr = ti >= 0 && hover - trades[ti].t < 2000 ? trades[ti] : null;
      const lines = [
        mmss(hover, p.windowStart, true),
        b ? `bid ${(b.bid * 100).toFixed(1)}¢ ×${b.bidSz}  ask ${(b.ask * 100).toFixed(1)}¢ ×${b.askSz}` : "no book yet",
        b ? `mid ${(((b.bid + b.ask) / 2) * 100).toFixed(2)}¢  spread ${((b.ask - b.bid) * 100).toFixed(1)}¢` : "",
        tr ? `trade ${(tr.px * 100).toFixed(1)}¢ ×${tr.qty} ${tr.takerBought ? "bought" : "sold"} (${mmss(tr.t, p.windowStart, true)})` : "",
      ].filter(Boolean);
      const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + 12;
      const bx = x + bw + 12 > w - PAD_R ? x - bw - 8 : x + 8;
      g.fillStyle = "rgba(22,27,34,0.95)";
      g.fillRect(bx, 8, bw, lines.length * 14 + 8);
      g.fillStyle = C.mid;
      lines.forEach((l, k) => g.fillText(l, bx + 6, 22 + k * 14));
    }
  }, [p, w, H, hover]);

  return (
    <div ref={wrap} className="w-full">
      <canvas
        ref={cv}
        style={{ width: w, height: H, display: "block", cursor: "crosshair" }}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const plotW = w - PAD_L - PAD_R;
          setHover(p.from + ((e.clientX - r.left - PAD_L) / plotW) * (p.to - p.from));
        }}
        onMouseLeave={() => setHover(null)}
      />
    </div>
  );
}
