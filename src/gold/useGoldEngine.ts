import { useCallback, useEffect, useRef, useState } from "react";
import type { Candle } from "./indicators";
import { Engine, type Nowcast, type Outcome, type Prediction } from "./model";
import { fitReversion, type ReversionFit } from "./reversion";
import { AnalogIndex, HORIZON, label } from "./forecast";
import { backtestFan, buildFan, calibrateFan, FanTracker, jevWeights, type BandCalibration, type Fan, type FanScore } from "./fan";
import { askJev, ratePaths, backendConfigured, backendVersion, LiveFeed, SimFeed, TF_SECONDS, type Feed } from "./feed";

export const MIN_EDGE = 0.56;
/** How often Jev re-reads the forming candle. Each check only calls Jev if something new happened. */
export const JEV_LIVE_SECONDS = 10;

export interface ClosedBar {
  candle: Candle;
  outcome: Outcome | null;
}

export type Summary = ReturnType<Engine["summary"]>;

export interface Forecast {
  forTime: number; //      time of forecast candle 1 (the candle forming now)
  startPrice: number; //   where the fan starts (candle 1's open)
  atr: number; //          dollars per ATR unit, to turn the fan into prices
  plain: Fan; //           from the analog paths alone
  jev: Fan | null; //      the same paths, weighted by Jev's ratings
  scenarios: number; //    how many paths
  pool: number; //         how many past candles they were drawn from
  updatedAt: number; //    ms timestamp
  note: string | null;
}

/** How the forecast fan has done: replayed on history at load, and live as forecasts play out. */
export interface ForecastScores {
  backtest: FanScore | null;
  /** Band stretch learned from the replay, applied to live fans (null = not learned yet). */
  calibration: BandCalibration | null;
  backtestRunning: boolean;
  livePlain: FanScore | null;
  liveJev: FanScore | null;
}

export interface GoldState {
  status: "loading" | "ready" | "error";
  source: string;
  jevOn: boolean;
  bars: ClosedBar[];
  forming: Candle | null;
  /** Live chance the forming candle closes green; updates on every tick. */
  live: Nowcast | null;
  prediction: Prediction | null;
  summary: Summary | null;
  error: string | null;
  jevError: string | null;
  jevPending: boolean;
  /** Jev's latest read on the forming candle. */
  jevLive: { pGreen: number; at: number } | null;
  /** 5-candle forecast (only while the toggle is on). */
  forecastOn: boolean;
  forecast: Forecast | null;
  forecastBusy: boolean;
  forecastScores: ForecastScores;
  /** Intra-candle mean reversion measured from 1-minute history (null until measured). */
  reversion: ReversionFit | null;
  /** Why Jev is or isn't reading the live candle right now, in plain words. */
  jevLiveStatus: string;
  /** Jev usage this session: calls sent, and live checks skipped because nothing new happened. */
  jevCalls: { open: number; live: number; skipped: number };
  /** Bumps on every closed candle so the chart knows to redraw markers. */
  version: number;
}

const MAX_BARS = 3000;
const FORECAST_PATHS = 2000;
/** How often the forecast reruns (one Jev tournament per run, shared by all viewers). */
export const FORECAST_EVERY_SECONDS = 60;

function readForecastPref(): boolean {
  try {
    return localStorage.getItem("gold.forecast") === "1";
  } catch {
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => (clearTimeout(id), resolve(v)),
      (e) => (clearTimeout(id), reject(e)),
    );
  });
}

export function useGoldEngine(): GoldState & { setForecastOn: (on: boolean) => void } {
  const [state, setState] = useState<GoldState>({
    status: "loading",
    source: backendConfigured() ? "Pyth" : "Simulated",
    jevOn: false,
    bars: [],
    forming: null,
    live: null,
    prediction: null,
    summary: null,
    error: null,
    jevError: null,
    jevPending: false,
    jevLive: null,
    jevLiveStatus: "starting…",
    reversion: null,
    forecastOn: readForecastPref(),
    forecast: null,
    forecastBusy: false,
    forecastScores: { backtest: null, calibration: null, backtestRunning: false, livePlain: null, liveJev: null },
    jevCalls: { open: 0, live: 0, skipped: 0 },
    version: 0,
  });
  const forecastWanted = useRef(state.forecastOn);
  const runForecastRef = useRef<() => void>(() => {});

  const setForecastOn = useCallback((on: boolean) => {
    forecastWanted.current = on;
    try {
      localStorage.setItem("gold.forecast", on ? "1" : "0");
    } catch {
      // private mode etc.: the toggle still works for this visit
    }
    setState((s) => ({ ...s, forecastOn: on, ...(on ? {} : { forecast: null }) }));
    if (on) runForecastRef.current();
  }, []);

  useEffect(() => {
    let feed: Feed = backendConfigured() ? new LiveFeed() : new SimFeed();
    const engine = new Engine(TF_SECONDS, MIN_EDGE, 300);
    const bars: ClosedBar[] = [];
    let stop: (() => void) | null = null;
    let queue = Promise.resolve();
    let cancelled = false;
    let lastForming: Candle | null = null;
    const calls = { open: 0, live: 0, skipped: 0 };
    let liveSupported: boolean | null = null;
    let forecastSupported = false;
    let reversionTimer: number | undefined;
    let poolTimer: number | undefined;

    const relive = () => {
      if (cancelled || !lastForming) return;
      const f = lastForming;
      const live = engine.nowcast(f, feed.now());
      setState((s) => ({ ...s, forming: f, live, summary: engine.summary() }));
    };

    const publish = (patch: Partial<GoldState> = {}) =>
      !cancelled &&
      setState((s) => ({
        ...s,
        bars: [...bars],
        summary: engine.summary(),
        jevOn: feed.jev,
        source: feed.name,
        ...patch,
      }));

    const onClose = async (c: Candle) => {
      const { outcome, next } = engine.close(c);
      bars.push({ candle: c, outcome });
      if (bars.length > MAX_BARS) bars.shift();
      setState((s) => ({ ...s, version: s.version + 1 }));
      lastForming = null;
      publish({ forming: null, live: null, prediction: next, jevPending: false, jevLive: null });
      scorePending();
      await consultJev(next);
      await runForecast();
    };

    /** Ask Jev about the pending prediction (the candle forming now or next). */
    const consultJev = async (fallback: Prediction | null) => {
      const snapshot = feed.jev && engine.warm ? engine.describeForJev() : null;
      if (!snapshot) return;
      publish({ jevPending: true });
      try {
        const v = await withTimeout(askJev(snapshot, { mode: "open" }), 20_000, "Jev took longer than 20s");
        calls.open += 1;

        const p = engine.applyJev(v.probGreen, v.confidence);
        publish({ prediction: p ?? fallback, jevError: null, jevPending: false, jevCalls: { ...calls } });
      } catch (e) {
        publish({ jevError: (e as Error).message, jevPending: false });
      }
    };

    /**
     * Every minute: up to 2,000 analog paths for the next 5 candles (following the candle forming now),
     * summarized as a fan (middle line, 50% and 80% bands, per-candle green odds). Jev rates every path and
     * those ratings re-weight the same fan. Both versions are scored as they play out.
     */
    let forecastKey = "";
    let forecastRunning = false;
    let pool: Candle[] = []; // ~a year of closed 15m candles: where the analogs come from
    let index: AnalogIndex | null = null;
    let indexKey = "";
    const analogPool = () => {
      const recent = bars.map((b) => b.candle);
      if (!pool.length || !recent.length) return recent;
      return [...pool.filter((c) => c.time < recent[0].time), ...recent];
    };
    const getIndex = () => {
      const key = `${pool.length}:${bars.length ? bars[bars.length - 1].candle.time : 0}`;
      if (!index || key !== indexKey) {
        index = new AnalogIndex(analogPool());
        indexKey = key;
      }
      return index;
    };

    // Live scoring: the first forecast made for each candle is checked once its 5 candles have closed.
    const pendingScores = new Map<number, { startPrice: number; atr: number; plain: Fan; jev: Fan | null }>();
    const livePlain = new FanTracker();
    const liveJevTracker = new FanTracker();
    const scorePending = () => {
      for (const [forTime, f] of pendingScores) {
        const end = forTime + (HORIZON - 1) * TF_SECONDS;
        const i0 = bars.findIndex((b) => b.candle.time === forTime);
        if (!bars.length || bars[bars.length - 1].candle.time < end) continue;
        pendingScores.delete(forTime);
        if (i0 < 0 || i0 + HORIZON > bars.length) continue;
        const actual = bars.slice(i0, i0 + HORIZON).map((b) => (b.candle.close - f.startPrice) / f.atr);
        livePlain.record(f.plain, actual);
        if (f.jev) liveJevTracker.record(f.jev, actual);
      }
      if (!cancelled)
        setState((s) => ({
          ...s,
          forecastScores: { ...s.forecastScores, livePlain: livePlain.summary(), liveJev: liveJevTracker.summary() },
        }));
    };

    let backtestDone = false;
    let bandCalibration: BandCalibration | null = null;
    const cal = (fan: Fan) => (bandCalibration ? calibrateFan(fan, bandCalibration) : fan);
    const runBacktest = async () => {
      if (backtestDone || cancelled || !forecastWanted.current) return;
      backtestDone = true;
      setState((s) => ({ ...s, forecastScores: { ...s.forecastScores, backtestRunning: true } }));
      const { score, calibration } = await backtestFan(getIndex(), { windows: 200, spacing: 4, paths: FORECAST_PATHS });
      bandCalibration = calibration;
      if (!cancelled)
        setState((s) => ({ ...s, forecastScores: { ...s.forecastScores, backtest: score, calibration, backtestRunning: false } }));
    };

    const runForecast = async (force = false) => {
      if (cancelled || forecastRunning || !forecastWanted.current || bars.length < 100) return;
      if (document.hidden && !force) return;
      const last = bars[bars.length - 1].candle;
      const now = feed.now();
      const key = `${last.time}:${Math.floor(now / FORECAST_EVERY_SECONDS)}`;
      if (!force && key === forecastKey) return;
      forecastKey = key;

      const start = last.time + TF_SECONDS;
      const f = lastForming && lastForming.time === start ? lastForming : null;
      const atr = engine.features.atr;
      const formingNow =
        f && atr
          ? {
              move: (f.close - f.open) / atr,
              high: (f.high - f.open) / atr,
              low: (f.low - f.open) / atr,
              elapsed: Math.min(1, Math.max(0, (now - f.time) / TF_SECONDS)),
            }
          : null;
      const idx = getIndex();
      const set = idx.scenarios(idx.history.length - 1, FORECAST_PATHS, formingNow);
      if (!set) return;
      const plain = cal(buildFan(set));
      const base: Forecast = {
        forTime: start,
        startPrice: f ? f.open : last.close,
        atr: set.atr,
        plain,
        jev: null,
        scenarios: set.scenarios.length,
        pool: idx.history.length,
        updatedAt: Date.now(),
        note: null,
      };
      const remember = (fc: Forecast) => {
        if (!pendingScores.has(start)) pendingScores.set(start, { startPrice: fc.startPrice, atr: fc.atr, plain: fc.plain, jev: fc.jev });
      };
      void runBacktest();

      const snapshot = engine.describeForForecast(f, now);
      if (!feed.jev || !forecastSupported || !snapshot) {
        const note = !feed.jev
          ? "Jev is off: range from the analog paths only."
          : !forecastSupported
            ? "Jev's weighting needs the new backend (ask Lovable to “Deploy the gold edge function”). Range from the analog paths only."
            : null;
        const fc = { ...base, note };
        remember(fc);
        if (!cancelled) setState((s) => ({ ...s, forecast: fc }));
        return;
      }
      forecastRunning = true;
      // Show the analog fan right away; Jev's weighting follows.
      if (!cancelled) setState((s) => ({ ...s, forecast: s.forecast && s.forecast.forTime === start ? { ...base, jev: s.forecast.jev } : base, forecastBusy: true }));
      try {
        const options = Object.fromEntries(set.scenarios.map((x) => [x.id, label(x)]));
        const v = await withTimeout(ratePaths(snapshot, options, key), 50_000, "Jev took longer than 50s");
        calls.open += v.calls;
        const fc: Forecast = { ...base, jev: cal(buildFan(set, jevWeights(set, v.ratings, v.batch))) };
        remember(fc);
        if (!cancelled) setState((s) => ({ ...s, forecast: fc, forecastBusy: false, jevCalls: { ...calls } }));
      } catch (e) {
        const fc = { ...base, note: `Jev's weighting failed (${(e as Error).message}). Range from the analog paths only.` };
        remember(fc);
        if (!cancelled) setState((s) => ({ ...s, forecast: fc, forecastBusy: false }));
      } finally {
        forecastRunning = false;
      }
    };
    runForecastRef.current = () => void runForecast(true);

    (async () => {
      let history: Candle[];
      try {
        history = await feed.history();
        if (cancelled) return;
      } catch (e) {
        // Backend not set up yet (or keys missing): fall back to simulation so the page still works.
        const msg = (e as Error).message;
        feed = new SimFeed();
        history = await feed.history();
        if (!cancelled) setState((s) => ({ ...s, error: `Live data unavailable (${msg}). Showing simulated gold.` }));
      }
      let prediction: Prediction | null = null;
      for (const c of history) {
        const { outcome, next } = engine.close(c);
        bars.push({ candle: c, outcome });
        prediction = next;
      }
      if (bars.length > MAX_BARS) bars.splice(0, bars.length - MAX_BARS);
      if (cancelled) return;
      publish({ status: "ready", prediction });
      setState((s) => ({ ...s, version: s.version + 1 }));
      // Measure intra-candle mean reversion from ~10 days of 1-minute bars; refresh every 6 hours.
      const measure = async () => {
        if (!(feed instanceof LiveFeed) || cancelled) return;
        try {
          const fit = fitReversion(await feed.minuteHistory(10), TF_SECONDS);
          if (fit && !cancelled) {
            engine.reversion = fit;
            setState((s) => ({ ...s, reversion: fit }));
          }
        } catch {
          // keep the random-walk fallback; the data errors already show elsewhere
        }
      };
      void measure();
      reversionTimer = window.setInterval(measure, 6 * 3600 * 1000);

      // A year of 15-minute history as the pool for forecast analogs (refreshed every 6 hours).
      const loadPool = async () => {
        if (!(feed instanceof LiveFeed) || cancelled) return;
        try {
          const p = await feed.deepHistory(365);
          if (p.length > pool.length && !cancelled) {
            pool = p;
            backtestDone = false;
            void runForecast(true);
          }
        } catch {
          // keep using the recent history
        }
      };
      void loadPool();
      poolTimer = window.setInterval(loadPool, 6 * 3600 * 1000);

      if (feed.name === "Pyth") {
        backendVersion()
          .then((v) => {
            liveSupported = !!v && v.features.includes("jev-live");
            forecastSupported = !!v && v.features.includes("forecast-ratings");
            void liveJev();
            void runForecast();
          })
          .catch(() => {
            liveSupported = false;
          });
      } else {
        liveSupported = false;
        void runForecast();
      }
      // Don't make the first Jev answer wait for the next candle close.
      queue = queue.then(() => consultJev(prediction));

      stop = feed.start(
        (c, closed) => {
          if (closed) queue = queue.then(() => onClose(c));
          else {
            lastForming = c;
            relive();
          }
        },
        (msg) => !cancelled && setState((s) => ({ ...s, error: `Live data hiccup: ${msg}` })),
      );
    })();

    // Time passing changes the odds too, so refresh the live read every second.
    const clock = window.setInterval(relive, 1000);

    // Every JEV_LIVE_SECONDS, show Jev only what is new in the forming candle.
    // Skipped (no TypeSafe call) when nothing changed, the outcome is already clear, or nobody is looking.
    let lastSent: { candle: number; price: number; high: number; low: number } | null = null;
    let liveBusy = false;
    const status = (jevLiveStatus: string) => {
      if (!cancelled) setState((s) => (s.jevLiveStatus === jevLiveStatus ? s : { ...s, jevLiveStatus }));
    };
    const skip = (why: string) => {
      calls.skipped += 1;
      if (!cancelled) setState((s) => ({ ...s, jevCalls: { ...calls }, jevLiveStatus: why }));
    };
    const liveJev = async () => {
      if (cancelled || liveBusy) return;
      if (!feed.jev) return status("off (no TypeSafe key on the backend)");
      if (liveSupported === null) return status("checking the backend…");
      if (!liveSupported) return status("paused: ask Lovable to “Deploy the gold edge function”");
      if (!engine.warm) return status("model still learning");
      if (document.hidden) return status("paused while the tab is hidden");
      if (!lastForming) return status("waiting for the candle to start");
      const f = lastForming;
      const now = feed.now();
      const nc = engine.nowcast(f, now);
      if (!nc) return status("waiting for the candle to start");
      const atr = engine.features.atr ?? 0;
      const since = lastSent && lastSent.candle === f.time ? lastSent : null;
      const nothingNew =
        since && Math.abs(f.close - since.price) < 0.05 * atr && f.high <= since.high && f.low >= since.low;
      if (nc.timeLeftFrac < 0.05) return skip("skipped: candle is about to close");
      if (nc.pPath > 0.95 || nc.pPath < 0.05) return skip("skipped: candle already decided by price");
      if (nothingNew) return skip("skipped: no new price movement in the last 10s");
      const snap = engine.describeLive(f, now, since);
      if (!snap) return;
      liveBusy = true;
      lastSent = { candle: f.time, price: f.close, high: f.high, low: f.low };
      try {
        const slotKey = `${f.time}:${Math.floor(now / JEV_LIVE_SECONDS)}`;
        const v = await withTimeout(askJev(snap, { mode: "live", slotKey }), 9_000, "Jev live read took longer than 9s");
        calls.live += 1;
        engine.applyJevLive(f, v.probGreen);
        if (!cancelled)
          setState((s) => ({ ...s, jevLive: { pGreen: v.probGreen, at: Date.now() }, jevCalls: { ...calls }, jevLiveStatus: "reading" }));
        relive();
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, jevError: (e as Error).message, jevLiveStatus: `error: ${(e as Error).message}` }));
      } finally {
        liveBusy = false;
      }
    };
    const jevClock = window.setInterval(liveJev, JEV_LIVE_SECONDS * 1000);
    // Checked every 10s; actually reruns once per minute (and right after each candle closes).
    const forecastClock = window.setInterval(() => void runForecast(), 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(clock);
      window.clearInterval(jevClock);
      window.clearInterval(reversionTimer);
      window.clearInterval(poolTimer);
      window.clearInterval(forecastClock);
      stop?.();
    };
  }, []);

  return { ...state, setForecastOn };
}
