import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
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

interface Props {
  bars: ClosedBar[];
  forming: Candle | null;
  ghost: Ghost | null;
  version: number;
}

export function GoldChart({ bars, forming, ghost, version }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ghostSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const drawnVersion = useRef(-1);
  const zoomed = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: COLORS.bg }, textColor: COLORS.muted },
      grid: { vertLines: { color: COLORS.line }, horzLines: { color: COLORS.line } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: COLORS.line, rightOffset: 4 },
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
    markers.current?.setMarkers(bars.flatMap(markerFor));
    if (!zoomed.current && chart.current) {
      zoomed.current = true;
      const show = window.innerWidth < 640 ? 40 : 120;
      chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - show), to: bars.length + 4 });
    }
  }, [bars, version]);

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

  return <div ref={el} className="h-full w-full" />;
}
