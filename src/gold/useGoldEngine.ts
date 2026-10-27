import { useEffect, useState } from "react";
import type { Candle } from "./indicators";
import { Engine, type Outcome, type Prediction } from "./model";
import { askJev, backendConfigured, LiveFeed, SimFeed, TF_SECONDS, type Feed } from "./feed";

export const MIN_EDGE = 0.56;
export const MIN_JEV_CONFIDENCE = 0.6;

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
  prediction: Prediction | null;
  summary: Summary | null;
  error: string | null;
  jevError: string | null;
  /** Bumps on every closed candle so the chart knows to redraw markers. */
  version: number;
}

const MAX_BARS = 3000;

export function useGoldEngine(): GoldState {
  const [state, setState] = useState<GoldState>({
    status: "loading",
    source: backendConfigured() ? "Pyth" : "Simulated",
    jevOn: false,
    bars: [],
    forming: null,
    prediction: null,
    summary: null,
    error: null,
    jevError: null,
    version: 0,
  });
  useEffect(() => {
    let feed: Feed = backendConfigured() ? new LiveFeed() : new SimFeed();
    const engine = new Engine(TF_SECONDS, MIN_EDGE, 300);
    const bars: ClosedBar[] = [];
    let stop: (() => void) | null = null;
    let queue = Promise.resolve();
    let cancelled = false;

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
      publish({ forming: null, prediction: next });

      const snapshot = feed.jev && engine.warm ? engine.describeForJev() : null;
      if (!snapshot) return;
      try {
        const v = await askJev(snapshot);
        const p = engine.applyJev(v.probGreen, v.confidence, MIN_JEV_CONFIDENCE);
        publish({ prediction: p ?? next, jevError: null });
      } catch (e) {
        publish({ jevError: (e as Error).message });
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

      stop = feed.start(
        (c, closed) => {
          if (closed) queue = queue.then(() => onClose(c));
          else if (!cancelled) setState((s) => ({ ...s, forming: c }));
        },
        (msg) => !cancelled && setState((s) => ({ ...s, error: `Live data hiccup: ${msg}` })),
      );
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return state;
}
