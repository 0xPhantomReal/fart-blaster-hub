import { useEffect, useState } from "react";
import type { Candle } from "./indicators";
import { Engine, type Nowcast, type Outcome, type Prediction } from "./model";
import { askJev, backendConfigured, LiveFeed, SimFeed, TF_SECONDS, type Feed } from "./feed";

export const MIN_EDGE = 0.56;

export interface ClosedBar {
  candle: Candle;
  outcome: Outcome | null;
}

export type Summary = ReturnType<Engine["summary"]>;

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
  /** Bumps on every closed candle so the chart knows to redraw markers. */
  version: number;
}

const MAX_BARS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => (clearTimeout(id), resolve(v)),
      (e) => (clearTimeout(id), reject(e)),
    );
  });
}

export function useGoldEngine(): GoldState {
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
    version: 0,
  });
  useEffect(() => {
    let feed: Feed = backendConfigured() ? new LiveFeed() : new SimFeed();
    const engine = new Engine(TF_SECONDS, MIN_EDGE, 300);
    const bars: ClosedBar[] = [];
    let stop: (() => void) | null = null;
    let queue = Promise.resolve();
    let cancelled = false;
    let lastForming: Candle | null = null;

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
      publish({ forming: null, live: null, prediction: next, jevPending: false });
      await consultJev(next);
    };

    /** Ask Jev about the pending prediction (the candle forming now or next). */
    const consultJev = async (fallback: Prediction | null) => {
      const snapshot = feed.jev && engine.warm ? engine.describeForJev() : null;
      if (!snapshot) return;
      publish({ jevPending: true });
      try {
        const v = await withTimeout(askJev(snapshot), 20_000, "Jev took longer than 20s");
        const p = engine.applyJev(v.probGreen, v.confidence);
        publish({ prediction: p ?? fallback, jevError: null, jevPending: false });
      } catch (e) {
        publish({ jevError: (e as Error).message, jevPending: false });
      }
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

    return () => {
      cancelled = true;
      window.clearInterval(clock);
      stop?.();
    };
  }, []);

  return state;
}
