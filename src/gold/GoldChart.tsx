import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  LineSeries,
  LineStyle,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "./indicators";
import type { Ghost } from "./model";
import type { ClosedBar } from "./useGoldEngine";

/** Forecast range to draw: one point per future candle close, starting from the anchor price. */
export interface FanLines {
  anchor: { time: number; price: number };
  points: { time: number; p10: number; p25: number; p50: number; p75: number; p90: number }[];
}
type Band = "p10" | "p25" | "p50" | "p75" | "p90";

const COLORS = { bg: "#0e1116", line: "#262c36", muted: "#8b949e", green: "#26a69a", red: "#ef5350", miss: "#6b7280" };

const toBar = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });

function markerFor(b: ClosedBar): SeriesMarker<Time>[] {
  const o = b.outcome;
  if (!o || o.call === 0) return [];
  const up = o.call === 1;
  return [
    {
      time: b.candle.time as UTCTimestamp,
      position: up ? "belowBar" : "aboveBar",
      shape: up ? "arrowUp" : "arrowDown",
      color: o.hit === false ? COLORS.miss : up ? COLORS.green : COLORS.red,
      size: 0.7,
    },
  ];
}

export interface PatternMark {
  time: number;
  name: string;
  bias: "bull" | "bear" | "neutral";
}
export interface PatternLine {
  from: { time: number; price: number };
  to: { time: number; price: number };
  bias: "bull" | "bear" | "neutral";
}

const SHORT: Record<string, string> = {
  "Bullish engulfing": "Engulf",
  "Bearish engulfing": "Engulf",
  "Bullish harami": "Harami",
  "Bearish harami": "Harami",
  "Hanging man": "Hang man",
  "Shooting star": "Shoot star",
  "Inverted hammer": "Inv hammer",
  "Piercing line": "Piercing",
  "Dark cloud cover": "Dark cloud",
  "Morning star": "Morn star",
  "Evening star": "Eve star",
  "Three white soldiers": "3 soldiers",
  "Three black crows": "3 crows",
  "Bullish marubozu": "Marubozu",
  "Bearish marubozu": "Marubozu",
  "Tweezer top": "Tweezer",
  "Tweezer bottom": "Tweezer",
};
const BIAS_COLOR = { bull: "rgba(38,166,154,0.9)", bear: "rgba(239,83,80,0.9)", neutral: "rgba(139,148,158,0.9)" };
const MAX_PATTERN_LINES = 8;

interface Props {
  bars: ClosedBar[];
  forming: Candle | null;
  ghost: Ghost | null;
  fan: FanLines | null;
  patternMarks: PatternMark[];
  patternLines: PatternLine[];
  version: number;
}

export function GoldChart({ bars, forming, ghost, fan, patternMarks, patternLines, version }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ghostSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fanSeries = useRef<Partial<Record<Band, ISeriesApi<"Line">>>>({});
  const lineSeries = useRef<ISeriesApi<"Line">[]>([]);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const drawnVersion = useRef(-1);
  const zoomed = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: COLORS.bg }, textColor: COLORS.muted },
      grid: { vertLines: { color: COLORS.line }, horzLines: { color: COLORS.line } },
      // Show times in the viewer's own time zone (the library defaults to UTC).
      localization: {
        timeFormatter: (t: number) =>
          new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: COLORS.line,
        rightOffset: 4,
        tickMarkFormatter: (t: number, type: TickMarkType) => {
          const d = new Date(t * 1000);
          // Day markers fall on UTC midnight; only label them as a date when that's also local midnight.
          const localMidnight = d.getHours() === 0 && d.getMinutes() === 0;
          return type < TickMarkType.Time && localMidnight
            ? d.toLocaleDateString([], { month: "short", day: "numeric" })
            : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        },
      },
      rightPriceScale: { borderColor: COLORS.line },
      crosshair: { mode: CrosshairMode.Normal },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: COLORS.green,
      downColor: COLORS.red,
      borderVisible: false,
      wickUpColor: COLORS.green,
      wickDownColor: COLORS.red,
    });
    ghostSeries.current = c.addSeries(CandlestickSeries, {
      upColor: "rgba(38,166,154,0.28)",
      downColor: "rgba(239,83,80,0.28)",
      borderVisible: true,
      borderUpColor: "rgba(38,166,154,0.9)",
      borderDownColor: "rgba(239,83,80,0.9)",
      wickUpColor: "rgba(38,166,154,0.7)",
      wickDownColor: "rgba(239,83,80,0.7)",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    // Forecast fan: gold middle line, dashed 50% band, dotted 80% band.
    const line = (color: string, width: 1 | 2, style: LineStyle) =>
      c.addSeries(LineSeries, {
        color,
        lineWidth: width,
        lineStyle: style,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    fanSeries.current = {
      p90: line("rgba(212,167,44,0.45)", 1, LineStyle.Dotted),
      p75: line("rgba(212,167,44,0.75)", 1, LineStyle.Dashed),
      p50: line("rgba(212,167,44,1)", 2, LineStyle.Solid),
      p25: line("rgba(212,167,44,0.75)", 1, LineStyle.Dashed),
      p10: line("rgba(212,167,44,0.45)", 1, LineStyle.Dotted),
    };
    // Chart-pattern lines (necklines, trendlines, support/resistance): a small reusable pool.
    lineSeries.current = Array.from({ length: MAX_PATTERN_LINES }, () =>
      c.addSeries(LineSeries, {
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }),
    );
    markers.current = createSeriesMarkers(candles.current, []);
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      drawnVersion.current = -1;
      zoomed.current = false;
    };
  }, []);

  // Full redraw when a candle closes.
  useEffect(() => {
    if (!candles.current || drawnVersion.current === version || !bars.length) return;
    drawnVersion.current = version;
    candles.current.setData(bars.map((b) => toBar(b.candle)));
    if (!zoomed.current && chart.current) {
      zoomed.current = true;
      const show = window.innerWidth < 640 ? 40 : 120;
      chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - show), to: bars.length + 4 });
    }
  }, [bars, version]);

  // Call arrows + candlestick-pattern labels (markers must be in time order).
  useEffect(() => {
    if (!markers.current) return;
    const pm: SeriesMarker<Time>[] = patternMarks.map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.bias === "bull" ? "belowBar" : "aboveBar",
      shape: "circle",
      size: 0.4,
      color: BIAS_COLOR[m.bias],
      text: SHORT[m.name] ?? m.name,
    }));
    const all = [...bars.flatMap(markerFor), ...pm].sort((a, b) => (a.time as number) - (b.time as number));
    markers.current.setMarkers(all);
  }, [bars, version, patternMarks]);

  useEffect(() => {
    lineSeries.current.forEach((ser, k) => {
      const l = patternLines[k];
      if (!l || l.to.time <= l.from.time) return ser.setData([]);
      ser.applyOptions({ color: BIAS_COLOR[l.bias] });
      ser.setData([
        { time: l.from.time as UTCTimestamp, value: l.from.price },
        { time: l.to.time as UTCTimestamp, value: l.to.price },
      ]);
    });
  }, [patternLines]);

  // Cheap update for the forming candle.
  useEffect(() => {
    if (!candles.current || !forming || !bars.length) return;
    if (forming.time > bars[bars.length - 1].candle.time) candles.current.update(toBar(forming));
  }, [forming, bars]);

  useEffect(() => {
    const s = ghostSeries.current;
    if (!s) return;
    if (!ghost) return s.setData([]);
    const neutral = ghost.dir === 0;
    s.setData([
      {
        ...toBar(ghost),
        ...(neutral
          ? { color: "rgba(139,148,158,0.25)", borderColor: "rgba(139,148,158,0.8)", wickColor: "rgba(139,148,158,0.6)" }
          : {}),
      },
    ]);
  }, [ghost]);

  useEffect(() => {
    const series = fanSeries.current;
    for (const band of ["p10", "p25", "p50", "p75", "p90"] as Band[]) {
      const ser = series[band];
      if (!ser) continue;
      ser.setData(
        fan
          ? [
              { time: fan.anchor.time as UTCTimestamp, value: fan.anchor.price },
              ...fan.points.map((p) => ({ time: p.time as UTCTimestamp, value: p[band] })),
            ]
          : [],
      );
    }
    if (fan && chart.current) {
      // Make room on the right for the 5 forecast candles.
      const ts = chart.current.timeScale();
      const r = ts.getVisibleLogicalRange();
      if (r && bars.length && r.to < bars.length + 6) ts.setVisibleLogicalRange({ from: r.from + 6, to: bars.length + 7 });
    }
  }, [fan, bars.length]);

  return <div ref={el} className="h-full w-full" />;
}
