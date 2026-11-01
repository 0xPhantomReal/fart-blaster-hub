import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import type { Candle } from "./indicators";
import { FootprintSeries, type FootprintBar } from "./footprintSeries";
import { rows as fpRows, type Footprint } from "./orderflow";
import type { ClosedBar } from "./useGold";

const COLORS = {
  bg: "#0e1116",
  line: "#262c36",
  muted: "#8b949e",
  green: "#26a69a",
  red: "#ef5350",
  miss: "#6b7280",
};

const toBar = (c: Candle) => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
});

/** An arrow on each candle a call was made for: colored if right, gray if wrong. */
function markerFor(
  b: ClosedBar,
  mode: "jev" | "refined" | "minute",
  minConf: number,
): SeriesMarker<Time>[] {
  const p = mode === "refined" ? b.pRef : mode === "minute" ? b.pMin : b.pJev;
  const c = b.candle;
  const o =
    mode === "minute"
      ? p === undefined
        ? null
        : {
            call: (p > 0.5 ? 1 : p < 0.5 ? -1 : 0) as -1 | 0 | 1,
            hit: c.close === c.open ? null : p > 0.5 === c.close > c.open,
          }
      : mode === "refined"
        ? b.refined
        : b.outcome;
  if (p === undefined || Math.max(p, 1 - p) < minConf) return []; // not confident enough to show
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

export function GoldChart({
  bars,
  forming,
  version,
  forecast,
  arrows = "jev",
  minConf = 0.5,
  decimals = 2,
  footprints = null,
  fpVersion = 0,
  footprintMode = false,
}: {
  footprints?: Map<number, Footprint> | null; // order flow per candle (crypto)
  fpVersion?: number; //                        bumps when footprints change
  footprintMode?: boolean; //                   draw footprint candles instead of plain ones
  decimals?: number; // price decimals (XRP needs 4)
  minConf?: number; // only draw arrows at least this sure (0.5 = every call)
  arrows?: "jev" | "refined" | "minute";
  bars: ClosedBar[];
  forming: Candle | null;
  version: number;
  forecast: Candle[] | null; // ghost bars for the next 5 candles, or null to hide
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const ghosts = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const fp = useRef<ISeriesApi<
    "Custom",
    Time,
    FootprintBar | WhitespaceData<Time>
  > | null>(null);
  const fpMarkers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const fpDrawn = useRef("");
  const drawn = useRef("");
  const zoomed = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: COLORS.bg }, textColor: COLORS.muted },
      grid: {
        vertLines: { color: COLORS.line },
        horzLines: { color: COLORS.line },
      },
      // Times in the viewer's own time zone (the library defaults to UTC).
      localization: {
        timeFormatter: (t: number) =>
          new Date(t * 1000).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: COLORS.line,
        rightOffset: 3,
        tickMarkFormatter: (t: number, type: TickMarkType) => {
          const d = new Date(t * 1000);
          const midnight = d.getHours() === 0 && d.getMinutes() === 0;
          return type < TickMarkType.Time && midnight
            ? d.toLocaleDateString([], { month: "short", day: "numeric" })
            : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        },
      },
      rightPriceScale: { borderColor: COLORS.line },
      crosshair: { mode: CrosshairMode.Normal },
    });
    // Added first so the real forming candle draws on top of the first forecast bar.
    ghosts.current = c.addSeries(CandlestickSeries, {
      upColor: "rgba(38,166,154,0.18)",
      downColor: "rgba(239,83,80,0.18)",
      borderVisible: true,
      borderUpColor: "rgba(38,166,154,0.85)",
      borderDownColor: "rgba(239,83,80,0.85)",
      wickUpColor: "rgba(38,166,154,0.6)",
      wickDownColor: "rgba(239,83,80,0.6)",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: COLORS.green,
      downColor: COLORS.red,
      borderVisible: false,
      wickUpColor: COLORS.green,
      wickDownColor: COLORS.red,
    });
    markers.current = createSeriesMarkers(candles.current, []);
    fp.current = c.addCustomSeries(new FootprintSeries(), {
      visible: false,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    fpMarkers.current = createSeriesMarkers(fp.current, []);
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      drawn.current = "";
      fpDrawn.current = "";
      zoomed.current = false;
    };
  }, []);

  useEffect(() => {
    const key = `${version}:${arrows}:${minConf}`;
    if (!candles.current || drawn.current === key || !bars.length) return;
    drawn.current = key;
    candles.current.setData(bars.map((b) => toBar(b.candle)));
    const ms = bars.flatMap((b) => markerFor(b, arrows, minConf));
    markers.current?.setMarkers(ms);
    fpMarkers.current?.setMarkers(ms);
    if (!zoomed.current && chart.current) {
      zoomed.current = true;
      const show = window.innerWidth < 640 ? 40 : 100;
      chart.current.timeScale().setVisibleLogicalRange({
        from: Math.max(0, bars.length - show),
        to: bars.length + 3,
      });
    }
  }, [bars, version, arrows, minConf]);

  useEffect(() => {
    const priceFormat = {
      type: "price" as const,
      precision: decimals,
      minMove: 1 / 10 ** decimals,
    };
    candles.current?.applyOptions({ priceFormat });
    ghosts.current?.applyOptions({ priceFormat });
    fp.current?.applyOptions({ priceFormat });
  }, [decimals]);

  useEffect(() => {
    if (!ghosts.current) return;
    ghosts.current.setData(forecast ? forecast.map(toBar) : []);
    // Keep the forecast in view when it first appears.
    if (forecast && chart.current) {
      const r = chart.current.timeScale().getVisibleLogicalRange();
      // Only when looking at the latest candles (don't yank the view if scrolled back in history).
      if (r && r.to >= bars.length - 2 && r.to < bars.length + forecast.length)
        chart.current.timeScale().setVisibleLogicalRange({
          from: r.from,
          to: bars.length + forecast.length + 1,
        });
    }
  }, [forecast, bars.length]);

  useEffect(() => {
    if (!candles.current || !forming || !bars.length) return;
    if (forming.time > bars[bars.length - 1].candle.time)
      candles.current.update(toBar(forming));
  }, [forming, bars]);

  // ── Footprint mode ──
  const toFp = (c: Candle): FootprintBar => {
    const f = footprints?.get(c.time);
    return {
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      ...(f && f.buy + f.sell > 0 ? { step: f.step, rows: fpRows(f) } : {}),
    };
  };

  useEffect(() => {
    candles.current?.applyOptions({ visible: !footprintMode });
    fp.current?.applyOptions({ visible: footprintMode });
    // Footprints need room: zoom in on the latest candles when switching on.
    if (footprintMode && chart.current && bars.length) {
      const show = window.innerWidth < 640 ? 3 : 7;
      chart.current.timeScale().setVisibleLogicalRange({
        from: bars.length - show,
        to: bars.length + 1.5,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the mode flips
  }, [footprintMode]);

  useEffect(() => {
    if (!fp.current || !footprintMode || !bars.length) return;
    const key = `${version}:${footprints?.size ?? 0}`;
    if (fpDrawn.current !== key) {
      fpDrawn.current = key;
      fp.current.setData(bars.map((b) => toFp(b.candle)));
    }
    if (forming && forming.time > bars[bars.length - 1].candle.time)
      fp.current.update(toFp(forming));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toFp reads the same props
  }, [footprintMode, bars, version, footprints, fpVersion, forming]);

  return <div ref={el} className="h-full w-full" />;
}
