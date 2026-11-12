import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
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
import { TV_COLORS, TV_INPUTS, type TvResult } from "./tvIndicator";
import { TvTriangles } from "./tvTriangles";
import { REGIME_COLORS, type Regime } from "./trendRegime";
import type { AutoReplayRow } from "./feed";

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
  mode: "jev" | "refined" | "minute" | "regime",
  minConf: number,
): SeriesMarker<Time>[] {
  const p =
    mode === "refined"
      ? b.pRef
      : mode === "minute"
        ? b.pMin
        : mode === "regime"
          ? b.pAdj
          : b.pJev;
  const c = b.candle;
  const o =
    mode === "minute" || mode === "regime"
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
  // A flip call (minute/regime reads): the call is the opposite of the candle's color when it was read → ★.
  const flip =
    (mode === "minute" || mode === "regime") &&
    b.minMove !== undefined &&
    b.minMove !== 0 &&
    up !== b.minMove > 0;
  return [
    {
      time: b.candle.time as UTCTimestamp,
      position: up ? "belowBar" : "aboveBar",
      shape: up ? "arrowUp" : "arrowDown",
      color: o.hit === false ? COLORS.miss : up ? COLORS.green : COLORS.red,
      size: 0.7,
      ...(flip ? { text: "★" } : {}),
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
  tv = null,
  regimes = null,
  replay = null,
}: {
  replay?: AutoReplayRow[] | null; // auto-mode replay: S/F (and ✓/✗ for real trades) above each call's candle
  regimes?: Map<number, { label: Regime }> | null; // background shading: the bot's trend check per candle
  tv?: TvResult | null; //                       the TradingView indicator (closed candles), or null to hide
  footprints?: Map<number, Footprint> | null; // order flow per candle (crypto)
  fpVersion?: number; //                        bumps when footprints change
  footprintMode?: boolean; //                   draw footprint candles instead of plain ones
  decimals?: number; // price decimals (XRP needs 4)
  minConf?: number; // only draw arrows at least this sure (0.5 = every call)
  arrows?: "jev" | "refined" | "minute" | "regime";
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
  const shown = useRef<{
    first: number;
    last: number;
    n: number;
    version: number;
  } | null>(null);
  const seriesLast = useRef<number | null>(null); // time of the last bar drawn on the candle series
  const formingRef = useRef<Candle | null>(null);
  const zoomed = useRef(false);
  const tvFast = useRef<ISeriesApi<"Line"> | null>(null);
  const shade = useRef<ISeriesApi<"Histogram"> | null>(null);
  const replayMarks = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const tvSlow = useRef<ISeriesApi<"Line"> | null>(null);
  const tvTri = useRef<TvTriangles[]>([]);

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
    // Trend shading: a full-height column behind each candle (own hidden scale fixed at 0–1), added first so it's at
    // the back.
    shade.current = c.addSeries(HistogramSeries, {
      priceScaleId: "regime",
      priceLineVisible: false,
      lastValueVisible: false,
      base: 0,
      visible: false,
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 1 },
      }),
    });
    c.priceScale("regime").applyOptions({
      visible: false,
      scaleMargins: { top: 0, bottom: 0 },
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
      // The forecast never rescales the price axis (it would jump every time the forecast is redrawn).
      autoscaleInfoProvider: () => null,
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
    // TradingView indicator: Fast/Slow EMA lines (Pine plot, width 1) and the next-candle triangles.
    const line = (color: string, title: string) =>
      c.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        title,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        visible: false,
      });
    // Auto-mode replay markers sit on the candles, alongside the signal arrows.
    replayMarks.current = createSeriesMarkers(candles.current, []);
    tvFast.current = line(TV_COLORS.orange, "Fast EMA");
    tvSlow.current = line(TV_COLORS.blue, "Slow EMA");
    tvTri.current = [new TvTriangles(), new TvTriangles()];
    candles.current.attachPrimitive(tvTri.current[0]);
    fp.current.attachPrimitive(tvTri.current[1]);
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      drawn.current = "";
      shown.current = null;
      seriesLast.current = null;
      fpDrawn.current = "";
      zoomed.current = false;
    };
  }, []);

  useEffect(() => {
    const key = `${version}:${arrows}:${minConf}:${tv ? 1 : 0}`;
    if (!candles.current || drawn.current === key || !bars.length) return;
    drawn.current = key;
    // A candle closing just appends one bar: update the series in place instead of redrawing everything, so the
    // view doesn't jump and the forming candle doesn't blink.
    const prev = shown.current;
    const firstT = bars[0].candle.time;
    const lastT = bars[bars.length - 1].candle.time;
    const appended =
      prev !== null &&
      prev.first === firstT &&
      bars.length === prev.n + 1 &&
      bars[bars.length - 2]?.candle.time === prev.last &&
      seriesLast.current !== null &&
      seriesLast.current <= lastT;
    if (appended) {
      candles.current.update(toBar(bars[bars.length - 1].candle));
    } else if (
      !prev ||
      prev.first !== firstT ||
      prev.n !== bars.length ||
      prev.last !== lastT ||
      version !== prev.version
    ) {
      const r = chart.current?.timeScale().getVisibleLogicalRange() ?? null;
      candles.current.setData(bars.map((b) => toBar(b.candle)));
      // Keep following the latest candles if that's where the view was.
      const delta = prev ? bars.length - prev.n : 0;
      if (r && prev && delta > 0 && delta < 50 && r.to >= prev.n - 2)
        chart.current
          ?.timeScale()
          .setVisibleLogicalRange({ from: r.from + delta, to: r.to + delta });
    }
    seriesLast.current = Math.max(seriesLast.current ?? 0, lastT);
    if (!appended && prev && seriesLast.current > lastT)
      seriesLast.current = lastT;
    // Put the forming candle back after a full redraw.
    if (formingRef.current && formingRef.current.time > lastT) {
      candles.current.update(toBar(formingRef.current));
      seriesLast.current = formingRef.current.time;
    }
    shown.current = { first: firstT, last: lastT, n: bars.length, version };
    // With the TradingView indicator on, only its triangles show (as on TradingView).
    const ms = tv ? [] : bars.flatMap((b) => markerFor(b, arrows, minConf));
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
  }, [bars, version, arrows, minConf, tv]);

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
    formingRef.current = forming;
    if (!candles.current || !forming || !bars.length) return;
    const lastClosed = bars[bars.length - 1].candle.time;
    if (forming.time <= lastClosed) return;
    if (seriesLast.current !== null && forming.time < seriesLast.current) {
      // Older than what's drawn (shouldn't happen): redraw cleanly.
      candles.current.setData([
        ...bars.map((b) => toBar(b.candle)),
        toBar(forming),
      ]);
    } else candles.current.update(toBar(forming));
    seriesLast.current = forming.time;
  }, [forming, bars]);

  // ── TradingView indicator ──
  useEffect(() => {
    const on = !!tv && bars.length > 0;
    tvFast.current?.applyOptions({ visible: on });
    tvSlow.current?.applyOptions({ visible: on });
    if (!on) {
      tvFast.current?.setData([]);
      tvSlow.current?.setData([]);
      for (const t of tvTri.current) t.set([]);
      return;
    }
    const pts = (k: "emaFast" | "emaSlow") =>
      tv!.bars.map((b) =>
        b[k] === null
          ? { time: b.time as UTCTimestamp }
          : { time: b.time as UTCTimestamp, value: b[k] as number },
      );
    tvFast.current?.setData(pts("emaFast"));
    tvSlow.current?.setData(pts("emaSlow"));
    const byTime = new Map(bars.map((b) => [b.candle.time, b.candle]));
    const tri = tv!.bars
      .filter((b) => b.bias !== 0 && byTime.has(b.time))
      .map((b) => {
        const c = byTime.get(b.time)!;
        return {
          time: b.time,
          up: b.bias === 1,
          high: c.high,
          low: c.low,
          color: b.bias === 1 ? TV_COLORS.green : TV_COLORS.red,
        };
      });
    for (const t of tvTri.current) t.set(tri);
  }, [tv, bars]);

  // Auto-mode replay: S (straight with Jev) / F (flip) above each call's candle, coloured by the trend at the call;
  // ✓ / ✗ when the bot really traded that window (with whether auto mode would have been on the same side).
  useEffect(() => {
    const m = replayMarks.current;
    if (!m) return;
    if (!replay || !replay.length || !bars.length) {
      m.setMarkers([]);
      return;
    }
    const byTime = new Map(bars.map((b) => [b.candle.time, b.candle]));
    const rows = replay
      .filter((r) => byTime.has(r.window))
      .sort((a, b) => a.window - b.window);
    m.setMarkers(
      rows.map((r) => {
        const color = /downtrend/.test(r.label)
          ? "#ef5350"
          : /uptrend/.test(r.label)
            ? "#26a69a"
            : "#8b949e";
        const res =
          r.actual?.result === "win"
            ? " ✓"
            : r.actual?.result === "loss"
              ? " ✗"
              : "";
        const diff = r.actual && r.sameSide === false && res ? "≠" : "";
        return {
          time: r.window as UTCTimestamp,
          position: "aboveBar" as const,
          shape: "circle" as const,
          color,
          size: 0.6,
          text: `${r.auto === "straight" ? "S" : "F"}${res}${diff}`,
        };
      }),
    );
  }, [replay, bars]);

  // Trend shading (the bot's auto-mode trend check per candle).
  useEffect(() => {
    const s = shade.current;
    if (!s) return;
    if (!regimes || !bars.length) {
      s.applyOptions({ visible: false });
      s.setData([]);
      return;
    }
    s.setData(
      bars.map((b) => {
        const r = regimes.get(b.candle.time);
        return {
          time: b.candle.time as UTCTimestamp,
          value: 1,
          color: r ? REGIME_COLORS[r.label] : "rgba(0,0,0,0)",
        };
      }),
    );
    s.applyOptions({ visible: true });
  }, [regimes, bars]);

  // The EMAs follow the forming candle's price, as TradingView plots them live.
  useEffect(() => {
    if (!tv || !forming || !tv.bars.length) return;
    const last = tv.bars[tv.bars.length - 1];
    if (forming.time <= last.time) return;
    const step = (prev: number | null, len: number) =>
      prev === null
        ? null
        : (2 / (len + 1)) * forming.close + (1 - 2 / (len + 1)) * prev;
    const f = step(last.emaFast, TV_INPUTS.emaFastLen);
    const s2 = step(last.emaSlow, TV_INPUTS.emaSlowLen);
    if (f !== null)
      tvFast.current?.update({ time: forming.time as UTCTimestamp, value: f });
    if (s2 !== null)
      tvSlow.current?.update({ time: forming.time as UTCTimestamp, value: s2 });
  }, [tv, forming]);

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
