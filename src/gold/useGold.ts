import { useEffect, useState } from "react";
import type { Candle } from "./indicators";
import { Predictor, type JevAnswer, type Live, type Outcome, type Prediction, type TrackRecord } from "./predictor";
import {
  askCheck,
  backendConfigured,
  backendVersion,
  LiveFeed,
  SimFeed,
  TF_SECONDS,
  tickCheck,
  type Feed,
  type TickCheck,
  type TickStatus,
} from "./feed";

/** How many recent past candles Jev is checked on before it is used live. */
export const BACKFILL = 200;

export interface ClosedBar {
  candle: Candle;
  outcome: Outcome | null;
}

type Trio = { model: TrackRecord; jev: TrackRecord; final: TrackRecord; halfway?: TrackRecord };

export interface GoldState {
  status: "loading" | "ready";
  source: string;
  error: string | null;
  bars: ClosedBar[]; //            last ~3,000 candles, for the chart
  forming: Candle | null;
  prediction: Prediction | null; // for the candle forming now / next (made at its open)
  live: Live | null; //            live chance the forming candle closes green (every tick / second)
  trainedOn: number; //            candles the model has learned from
  walkForward: TrackRecord | null; // model record over all history (each prediction made before its candle)
  backfill: Trio | null; //        model vs Jev vs final on the same recent past candles
  liveRecord: Trio | null; //      this session
  trust: { model: number; jev: number } | null;
  jev: { on: boolean; status: string; calls: number };
  /** Live tick stream health, plus the backend's diagnosis when it isn't streaming. */
  ticks: TickStatus & { check: TickCheck | null };
  version: number; //              bumps when the chart should redraw
}

const MAX_BARS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`no answer after ${ms / 1000}s`)), ms);
    p.then(
      (v) => (clearTimeout(id), resolve(v)),
      (e) => (clearTimeout(id), reject(e)),
    );
  });
}

// Jev answers for past candles never change, so keep them in the browser to avoid paying twice.
const CACHE_KEY = "gold.jevcheck.v1";
function readCache(): Record<string, JevAnswer> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function writeCache(c: Record<string, JevAnswer>) {
  try {
    const keys = Object.keys(c).sort();
    const trimmed = Object.fromEntries(keys.slice(-600).map((k) => [k, c[k]]));
    localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // storage unavailable: answers are just fetched again next visit
  }
}

export function useGold(): GoldState {
  const [state, setState] = useState<GoldState>({
    status: "loading",
    source: backendConfigured() ? "Pyth" : "Simulated",
    error: null,
    bars: [],
    forming: null,
    prediction: null,
    live: null,
    trainedOn: 0,
    walkForward: null,
    backfill: null,
    liveRecord: null,
    trust: null,
    jev: { on: false, status: "starting…", calls: 0 },
    ticks: { state: "connecting", detail: "", check: null },
    version: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let feed: Feed = backendConfigured() ? new LiveFeed() : new SimFeed();
    let predictor = new Predictor(TF_SECONDS);
    let bars: ClosedBar[] = [];
    let queue = Promise.resolve();
    let stop: (() => void) | null = null;
    let jevReady = false; // backend supports the check AND the backfill has run
    let jevCalls = 0;
    const set = (patch: Partial<GoldState>) => !cancelled && setState((s) => ({ ...s, ...patch }));
    const setJev = (patch: Partial<GoldState["jev"]>) => !cancelled && setState((s) => ({ ...s, jev: { ...s.jev, ...patch } }));

    /** Train a fresh predictor walk-forward over `history`. Returns the predictions it made, by candle time. */
    const train = (history: Candle[]) => {
      const p = new Predictor(TF_SECONDS);
      const outcomes = new Map<number, Outcome | null>();
      const preds = new Map<number, Prediction>();
      let next: Prediction | null = null;
      for (const c of history) {
        const r = p.close(c);
        outcomes.set(c.time, r.outcome);
        next = r.next;
        preds.set(next.forTime, next);
      }
      return { p, outcomes, preds, next };
    };

    const liveRecord = (): Trio => {
      const s = predictor.summary();
      return { model: s.model, jev: s.jev, final: s.final, halfway: s.halfway };
    };

    /** Ask Jev about the pending candle and fold its answers in. */
    const consult = async (pred: Prediction) => {
      if (!jevReady) return;
      const snap = predictor.snapshotFor(pred.forTime);
      if (!snap) return;
      setJev({ status: "checking this candle…" });
      try {
        const a = await withTimeout(askCheck(snap, pred.forTime), 20_000);
        jevCalls += a.support === null ? 1 : 2;
        const updated = predictor.applyJev({ pGreen: a.pGreen, support: a.support });
        if (updated) set({ prediction: updated, trust: predictor.summary().trust });
        setJev({ status: "ok", calls: jevCalls });
      } catch (e) {
        setJev({ status: `error: ${(e as Error).message}` });
      }
    };

    /** Check Jev on the latest ~200 past candles before trusting it live. */
    const runBackfill = async (preds: Map<number, Prediction>, history: Candle[]) => {
      const cache = readCache();
      const targets = history.slice(-BACKFILL).filter((c) => preds.get(c.time)?.pModel != null && predictor.snapshotFor(c.time));
      const answers = new Map<number, JevAnswer>();
      let done = 0;
      const worker = async (list: Candle[]) => {
        for (const c of list) {
          if (cancelled) return;
          const cachedA = cache[String(c.time)];
          if (cachedA) answers.set(c.time, cachedA);
          else {
            try {
              const a = await withTimeout(askCheck(predictor.snapshotFor(c.time), c.time), 30_000);
              const ans = { pGreen: a.pGreen, support: a.support };
              answers.set(c.time, ans);
              cache[String(c.time)] = ans;
              jevCalls += a.support === null ? 1 : 2;
            } catch {
              // skip this candle
            }
          }
          done += 1;
          if (done % 10 === 0) setJev({ status: `checking Jev on past candles: ${done} of ${targets.length}`, calls: jevCalls });
        }
      };
      // 6 at a time
      const lanes = Array.from({ length: 6 }, (_, k) => targets.filter((_, i) => i % 6 === k));
      await Promise.all(lanes.map(worker));
      writeCache(cache);
      const rows = targets
        .filter((c) => answers.has(c.time) && c.close !== c.open)
        .map((c) => ({ pModel: preds.get(c.time)!.pModel!, jev: answers.get(c.time)!, y: (c.close > c.open ? 1 : 0) as 0 | 1 }));
      if (rows.length < 30) {
        setJev({ status: "couldn't check Jev on enough past candles; using the model alone", calls: jevCalls });
        return false;
      }
      set({ backfill: predictor.backfill(rows), trust: predictor.summary().trust });
      setJev({ status: "ok", calls: jevCalls });
      return true;
    };

    let current: Prediction | null = null;
    let lastForming: Candle | null = null;

    /** (Re)train on `history` (walk-forward) and make it the live predictor. */
    const adopt = (history: Candle[]) => {
      const t = train(history);
      predictor = t.p;
      current = t.next;
      bars = history.slice(-MAX_BARS).map((c) => ({ candle: c, outcome: t.outcomes.get(c.time) ?? null }));
      set({
        status: "ready",
        bars: [...bars],
        prediction: t.next,
        trainedOn: history.length,
        walkForward: predictor.summary().model,
        liveRecord: null,
        backfill: null,
        trust: predictor.summary().trust,
      });
      setState((s) => ({ ...s, version: s.version + 1 }));
      return t;
    };

    /** Once training is final: check Jev on recent past candles, then use it live. Runs outside the candle queue. */
    const hookJev = async (t: ReturnType<typeof train>, history: Candle[]) => {
      if (!feed.jev) return setJev({ on: false, status: "off (no TypeSafe key on the backend)" });
      setJev({ on: true });
      const v = await backendVersion().catch(() => null);
      if (!v || !v.features.includes("jev-check")) {
        return setJev({ status: "waiting for the new backend: ask Lovable to “Deploy the gold edge function”" });
      }
      jevReady = await runBackfill(t.preds, history);
      if (jevReady && current) await consult(current);
    };

    const onClose = async (c: Candle) => {
      const { outcome, next } = predictor.close(c);
      bars.push({ candle: c, outcome });
      if (bars.length > MAX_BARS) bars.shift();
      current = next;
      lastForming = null;
      setState((s) => ({ ...s, bars: [...bars], forming: null, prediction: next, live: null, liveRecord: liveRecord() }));
      setState((s) => ({ ...s, version: s.version + 1 }));
      await consult(next);
    };

    (async () => {
      let history: Candle[];
      try {
        history = await feed.history();
      } catch (e) {
        feed = new SimFeed();
        history = await feed.history();
        set({ error: `Live data unavailable (${(e as Error).message}). Showing simulated gold.` });
      }
      if (cancelled) return;
      set({ source: feed.name });
      const first = adopt(history);

      if (feed instanceof LiveFeed) {
        // Retrain on ~a year of history once it arrives (more data = a steadier model and a longer record),
        // then hook Jev up to the final model.
        const lf = feed;
        void lf
          .deepHistory(365)
          .catch(() => [] as Candle[])
          .then((deep) => {
            if (cancelled) return;
            if (deep.length <= history.length) return void hookJev(first, history);
            queue = queue.then(() => {
              const recent = bars.map((b) => b.candle);
              const merged = [...deep.filter((c) => c.time < (recent[0]?.time ?? Infinity)), ...recent];
              void hookJev(adopt(merged), merged);
            });
          });
      } else void hookJev(first, history);

      let diagnosed = false;
      stop = feed.start(
        (c, closed) => {
          if (closed) queue = queue.then(() => onClose(c));
          // Data is flowing again, so a previous hiccup message no longer applies.
          else {
            lastForming = c;
            const live = predictor.live(c, feed.now());
            setState((s) => ({ ...s, forming: c, live, error: s.error?.startsWith("Live data hiccup") ? null : s.error }));
          }
        },
        (msg) => set({ error: `Live data hiccup: ${msg}` }),
        (st) => {
          setState((s) => ({ ...s, ticks: { ...st, check: st.state === "streaming" ? null : s.ticks.check } }));
          // First time ticks fall back: ask the backend to test the stream and name the exact problem.
          if (st.state === "fallback" && !diagnosed && feed instanceof LiveFeed) {
            diagnosed = true;
            void backendVersion()
              .then((v) => (v?.features.includes("tickcheck") ? tickCheck() : null))
              .then((check) => check && setState((s) => ({ ...s, ticks: { ...s.ticks, check } })))
              .catch(() => {});
          }
        },
      );
    })();

    // Time running out changes the odds too, so refresh the live read every second.
    const clock = window.setInterval(() => {
      if (!lastForming || cancelled) return;
      const live = predictor.live(lastForming, feed.now());
      setState((s) => ({ ...s, live }));
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(clock);
      stop?.();
    };
  }, []);

  return state;
}
