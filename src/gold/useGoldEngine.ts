import { useCallback, useEffect, useRef, useState } from "react";
import type { Candle } from "./indicators";
import { Engine, type Nowcast, type Outcome, type Prediction } from "./model";
import { fitReversion, type ReversionFit } from "./reversion";
import { buildScenarios, label, medoid, toCandles } from "./forecast";
import { askForecast, askJev, backendConfigured, backendVersion, LiveFeed, SimFeed, TF_SECONDS, type Feed } from "./feed";

export const MIN_EDGE = 0.56;
/** How often Jev re-reads the forming candle. Each check only calls Jev if something new happened. */
export const JEV_LIVE_SECONDS = 10;

export interface ClosedBar {
  candle: Candle;
  outcome: Outcome | null;
}

export type Summary = ReturnType<Engine["summary"]>;

export interface Forecast {
  forTime: number; //        first forecast candle's time
  candles: Candle[]; //      the 5 candles to draw
  picked: "jev" | "typical"; // Jev's pick, or the most typical path when Jev isn't available
  pJev: number | null; //    Jev's probability for the picked path
  rank: { pJev: number }[]; // top few Jev probabilities, for context
  scenarios: number; //      how many paths Jev chose from
  endsHigherPct: number; //  share of all paths that finish above the current price
  note: string | null;
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
const FORECAST_PATHS = 200;

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

    /** Build ~200 analog paths for the next 5 candles and let Jev pick the most likely one. */
    let forecastFor = -1;
    const runForecast = async () => {
      if (cancelled || !forecastWanted.current || bars.length < 100) return;
      const last = bars[bars.length - 1].candle;
      if (forecastFor === last.time) return; // already done for this candle
      forecastFor = last.time;
      const set = buildScenarios(
        bars.map((b) => b.candle),
        FORECAST_PATHS,
      );
      if (!set) return;
      const start = last.time + TF_SECONDS;
      const draw = (id: string) => toCandles(set.scenarios.find((x) => x.id === id)!, start, last.close, set.atr, TF_SECONDS);
      const typical = medoid(set);
      const base = { forTime: start, scenarios: set.scenarios.length, endsHigherPct: set.endsHigherPct };
      const fallback = (note: string): Forecast => ({ ...base, candles: draw(typical.id), picked: "typical", pJev: null, rank: [], note });

      const snapshot = engine.describeForJev();
      if (!feed.jev || !forecastSupported || !snapshot) {
        const why = !feed.jev
          ? "Jev is off, so this is the most typical of the paths."
          : !forecastSupported
            ? "Jev's pick needs the new backend (ask Lovable to “Deploy the gold edge function”). Showing the most typical path."
            : "Showing the most typical path.";
        if (!cancelled) setState((s) => ({ ...s, forecast: fallback(why) }));
        return;
      }
      setState((s) => ({ ...s, forecastBusy: true }));
      try {
        const options = Object.fromEntries(set.scenarios.map((x) => [x.id, label(x)]));
        const v = await withTimeout(askForecast(snapshot, options, `forecast:${last.time}`), 30_000, "Jev forecast took longer than 30s");
        calls.open += 1;
        const ranked = Object.entries(v.probabilities).sort((a, b) => b[1] - a[1]);
        const [bestId, bestP] = ranked[0] ?? [typical.id, 0];
        const f: Forecast = {
          ...base,
          candles: draw(set.scenarios.some((x) => x.id === bestId) ? bestId : typical.id),
          picked: "jev",
          pJev: bestP,
          rank: ranked.slice(0, 3).map(([, p]) => ({ pJev: p })),
          note: null,
        };
        if (!cancelled) setState((s) => ({ ...s, forecast: f, forecastBusy: false, jevCalls: { ...calls } }));
      } catch (e) {
        if (!cancelled)
          setState((s) => ({ ...s, forecast: fallback(`Jev forecast failed (${(e as Error).message}). Showing the most typical path.`), forecastBusy: false }));
      }
    };
    runForecastRef.current = () => {
      forecastFor = -1;
      void runForecast();
    };

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

      if (feed.name === "Pyth") {
        backendVersion()
          .then((v) => {
            liveSupported = !!v && v.features.includes("jev-live");
            forecastSupported = !!v && v.features.includes("jev-forecast");
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

    return () => {
      cancelled = true;
      window.clearInterval(clock);
      window.clearInterval(jevClock);
      window.clearInterval(reversionTimer);
      stop?.();
    };
  }, []);

  return { ...state, setForecastOn };
}
