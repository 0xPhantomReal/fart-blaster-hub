// Footprint candles for lightweight-charts (custom series).
//
// Zoomed in, each candle is drawn like a footprint chart: per price level, the volume delta (aggressive buys −
// aggressive sells) as a bar to the left (blue = buyers, red = sellers), the total volume as a gray bar to the
// right, a thin candle body in the middle, and the numbers when there's room. The busiest level (point of control)
// is outlined. Zoomed out, or for candles without trade data, it falls back to an ordinary candle.

import type {
  CustomData,
  CustomSeriesOptions,
  CustomSeriesPricePlotValues,
  CustomSeriesWhitespaceData,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  Time,
} from "lightweight-charts";
import { customSeriesDefaultOptions } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export interface FootprintRow {
  price: number; // level bottom
  buy: number;
  sell: number;
}

export interface FootprintBar extends CustomData<Time> {
  open: number;
  high: number;
  low: number;
  close: number;
  step?: number;
  rows?: FootprintRow[];
}

const C = {
  up: "#26a69a",
  down: "#ef5350",
  buy: "#4f8fd1",
  sell: "#d9534f",
  vol: "#5b6270",
  text: "#c9d1d9",
  poc: "#d4a72c",
};

/** Short number: 1234 → 1.2k, 12.3 → 12, 0.534 → .53 */
export function fmtVol(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}k`;
  if (a >= 100) return `${s}${a.toFixed(0)}`;
  if (a >= 10) return `${s}${a.toFixed(1)}`;
  if (a >= 1) return `${s}${a.toFixed(2)}`;
  return `${s}${a.toFixed(2).replace(/^0/, "")}`;
}

class Renderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, FootprintBar> | null = null;
  update(d: PaneRendererCustomData<Time, FootprintBar>) {
    this.data = d;
  }

  draw(target: CanvasRenderingTarget2D, toY: PriceToCoordinateConverter) {
    const d = this.data;
    if (!d || !d.visibleRange) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const spacing = d.barSpacing * Math.max(1, d.conflationFactor);
      for (let i = d.visibleRange!.from; i < d.visibleRange!.to; i++) {
        const bar = d.bars[i];
        if (!bar) continue;
        const b = bar.originalData;
        const y = (p: number) => toY(p) ?? 0;
        const w = spacing * 0.9;
        const rows = b.rows ?? [];
        const rowH = b.step ? Math.abs(y(0) - y(b.step)) : 0;
        if (!rows.length || w < 36 || rowH < 2) {
          this.candle(ctx, bar.x, w, b, y);
          continue;
        }
        this.footprint(ctx, bar.x, w, b, rows, rowH, y);
      }
    });
  }

  private candle(ctx: CanvasRenderingContext2D, x: number, w: number, b: FootprintBar, y: (p: number) => number) {
    const color = b.close >= b.open ? C.up : C.down;
    const bw = Math.max(1, Math.min(w * 0.8, w - 1));
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x) - 0.5, y(b.high), 1, Math.max(1, y(b.low) - y(b.high)));
    const top = y(Math.max(b.open, b.close));
    ctx.fillRect(x - bw / 2, top, bw, Math.max(1, y(Math.min(b.open, b.close)) - top));
  }

  private footprint(
    ctx: CanvasRenderingContext2D,
    x: number,
    w: number,
    b: FootprintBar,
    rows: FootprintRow[],
    rowH: number,
    y: (p: number) => number,
  ) {
    const step = b.step!;
    const left = x - w / 2;
    const strip = Math.max(3, Math.min(6, w * 0.05));
    const half = (w - strip) / 2;
    const numbers = w >= 84 && rowH >= 9;
    const numW = numbers ? Math.min(30, half * 0.5) : 0;
    const barMax = half - numW - 2;
    const maxDelta = Math.max(...rows.map((r) => Math.abs(r.buy - r.sell)), 1e-12);
    const maxVol = Math.max(...rows.map((r) => r.buy + r.sell), 1e-12);
    let pocRow = rows[0];
    for (const r of rows) if (r.buy + r.sell > pocRow.buy + pocRow.sell) pocRow = r;
    const cx = left + half; // left edge of the body strip
    const fontPx = Math.max(8, Math.min(11, rowH - 2));
    ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "middle";

    for (const r of rows) {
      const yTop = y(r.price + step);
      const yBot = y(r.price);
      const h = Math.max(1, Math.abs(yBot - yTop) - (rowH > 4 ? 1 : 0));
      const ym = Math.min(yTop, yBot);
      const delta = r.buy - r.sell;
      const vol = r.buy + r.sell;
      // Delta bar grows left from the number column.
      const dw = (Math.abs(delta) / maxDelta) * barMax;
      ctx.fillStyle = delta >= 0 ? C.buy : C.sell;
      ctx.fillRect(cx - numW - 1 - dw, ym, dw, h);
      // Volume bar grows right from the number column.
      const vw = (vol / maxVol) * barMax;
      ctx.fillStyle = C.vol;
      ctx.fillRect(cx + strip + numW + 1, ym, vw, h);
      if (numbers) {
        ctx.fillStyle = delta >= 0 ? "#8fbbe8" : "#f08a86";
        ctx.textAlign = "right";
        ctx.fillText(fmtVol(delta), cx - 2, ym + h / 2);
        ctx.fillStyle = r.buy === 0 || r.sell === 0 ? "#c58af9" : C.text; // one-sided (zero print) in purple
        ctx.textAlign = "left";
        ctx.fillText(fmtVol(vol), cx + strip + 2, ym + h / 2);
      }
      if (r === pocRow) {
        ctx.strokeStyle = C.poc;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + strip + numW + 1.5, ym + 0.5, Math.max(1, vw - 1), Math.max(1, h - 1));
      }
    }
    // Candle body strip with wick.
    const color = b.close >= b.open ? C.up : C.down;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(cx, y(b.high), strip, Math.max(1, y(b.low) - y(b.high)));
    ctx.globalAlpha = 1;
    const top = y(Math.max(b.open, b.close));
    ctx.fillRect(cx, top, strip, Math.max(1, y(Math.min(b.open, b.close)) - top));
  }
}

export class FootprintSeries implements ICustomSeriesPaneView<Time, FootprintBar, CustomSeriesOptions> {
  private r = new Renderer();
  renderer() {
    return this.r;
  }
  update(data: PaneRendererCustomData<Time, FootprintBar>) {
    this.r.update(data);
  }
  priceValueBuilder(b: FootprintBar): CustomSeriesPricePlotValues {
    return [b.low, b.high, b.close];
  }
  isWhitespace(d: FootprintBar | CustomSeriesWhitespaceData<Time>): d is CustomSeriesWhitespaceData<Time> {
    return (d as FootprintBar).close === undefined;
  }
  defaultOptions(): CustomSeriesOptions {
    return { ...customSeriesDefaultOptions, color: C.up };
  }
}
