// Small filled triangles under/over candles, like Pine's plotshape(shape.triangleup / triangledown, size.tiny).
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export interface Triangle {
  time: number;
  up: boolean; //  up = below the bar (next green), down = above the bar (next red)
  high: number;
  low: number;
  color: string;
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(
    private pts: { x: number; y: number; up: boolean; color: string }[],
    private size: number,
  ) {}
  draw(target: CanvasRenderingTarget2D) {
    target.useBitmapCoordinateSpace(
      ({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        for (const p of this.pts) {
          const x = p.x * hr;
          const half = (this.size / 2) * hr;
          const h = this.size * 0.85 * vr;
          const gap = 4 * vr;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          if (p.up) {
            const top = p.y * vr + gap; // below the low, pointing up
            ctx.moveTo(x, top);
            ctx.lineTo(x - half, top + h);
            ctx.lineTo(x + half, top + h);
          } else {
            const bottom = p.y * vr - gap; // above the high, pointing down
            ctx.moveTo(x, bottom);
            ctx.lineTo(x - half, bottom - h);
            ctx.lineTo(x + half, bottom - h);
          }
          ctx.closePath();
          ctx.fill();
        }
      },
    );
  }
}

class View implements IPrimitivePaneView {
  constructor(private src: TvTriangles) {}
  renderer() {
    const chart = this.src.chart;
    const series = this.src.series;
    if (!chart || !series || !this.src.items.length) return null;
    const ts = chart.timeScale();
    const pts: { x: number; y: number; up: boolean; color: string }[] = [];
    for (const t of this.src.items) {
      const x = ts.timeToCoordinate(t.time as UTCTimestamp);
      const y = series.priceToCoordinate(t.up ? t.low : t.high);
      if (x === null || y === null) continue;
      pts.push({ x, y, up: t.up, color: t.color });
    }
    // size.tiny, but never wider than the candle spacing
    const spacing = ts.options().barSpacing;
    return new Renderer(pts, Math.max(4, Math.min(8, spacing * 0.8)));
  }
}

export class TvTriangles implements ISeriesPrimitive<Time> {
  chart: IChartApi | null = null;
  series: ISeriesApi<SeriesType> | null = null;
  items: Triangle[] = [];
  private req: (() => void) | null = null;
  private views = [new View(this)];
  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<SeriesType>;
    this.req = p.requestUpdate;
  }
  detached() {
    this.chart = null;
    this.series = null;
    this.req = null;
  }
  paneViews() {
    return this.views;
  }
  updateAllViews() {}
  set(items: Triangle[]) {
    this.items = items;
    this.req?.();
  }
}
