import { useEffect, useState } from "react";
import type { Candle } from "./indicators";
import { Predictor, type JevAnswer, type Live, type Outcome, type Prediction, type TrackRecord } from "./predictor";
import { atrByTime, bodySd, FlipBlender, flipState, greenFromFlip, pastSnapshots, type FlipRecords, type FlipRow } from "./flip";
import {
  askCheck,
  askFlip,
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
/** How many past candles Jev's flip read is replayed on (rebuilt partway through from 1-minute data). */
export const FLIP_BACKFILL = 150;
/** How often Jev re-reads the forming candle. */
export const FLIP_SECONDS = 30;

/** Jev's read on whether the forming candle will flip, and how the flip check has scored. */
export interface FlipView {
  status: string;
  pFlip: number | null; //    Jev's latest chance the candle flips
  pMath: number | null; //    the math's chance of green, for comparison
  at: number | null; //       ms timestamp of Jev's latest read
  backfill: FlipRecords | null;
  live: FlipRecords | null;
  weights: { math: number; jev: number } | null;
  calls: number;
}

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
  flip: FlipView;
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

const FLIP_CACHE = "gold.flipcheck.v1";
function readFlipCache(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FLIP_CACHE) ?? "{}");
  } catch {
    return {};
  }
}
function writeFlipCache(c: Record<string, number>) {
  try {
    const keys = Object.keys(c).sort();
    localStorage.setItem(FLIP_CACHE, JSON.stringify(Object.fromEntries(keys.slice(-500).map((k) => [k, c[k]]))));
  } catch {
    // fine: fetched again next visit
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
    flip: { status: "starting…", pFlip: null, pMath: null, at: null, backfill: null, live: null, weights: null, calls: 0 },
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

    // ── Flip check: will the forming candle flip before it closes? ──────
    const blender = new FlipBlender();
    let flipReady = false;
    let flipCalls = 0;
    let lastFlip: { forTime: number; move: number; pFlip: number; at: number } | null = null;
    let halfwayFlip: { forTime: number; pMath: number; pJev: number; move: number } | null = null;
    const setFlip = (patch: Partial<FlipView>) => !cancelled && setState((s) => ({ ...s, flip: { ...s.flip, ...patch } }));

    /** Live read: the math, blended with Jev's latest flip read when it is fresh (< 45 s old). */
    const computeLive = (c: Candle): Live | null => {
      const math = predictor.live(c, feed.now());
      if (!math) return null;
      const move = c.close - c.open;
      const fresh = lastFlip && lastFlip.forTime === c.time && Date.now() - lastFlip.at < 45_000 && move !== 0;
      if (!fresh) return math;
      const pJev = greenFromFlip(move, lastFlip!.pFlip);
      const pGreen = blender.blend(math.pGreen, pJev);
      // Keep one mid-candle sample per candle for scoring the flip check.
      if (math.timeLeftFrac <= 0.5 && (!halfwayFlip || halfwayFlip.forTime !== c.time)) halfwayFlip = { forTime: c.time, pMath: math.pGreen, pJev, move };
      return { ...math, pGreen, call: pGreen >= 0.55 ? 1 : pGreen <= 0.45 ? -1 : 0 };
    };

    /** Ask Jev about the forming candle (every FLIP_SECONDS; shared per slot by all viewers). */
    const flipTick = async () => {
      const c = lastForming;
      if (cancelled || !flipReady || !c || document.hidden) return;
      const now = feed.now();
      const secondsLeft = c.time + TF_SECONDS - now;
      const atr = predictor.atr;
      const sd = bodySd(bars.map((b) => b.candle));
      if (secondsLeft < 30 || secondsLeft > TF_SECONDS - 30 || !atr || !sd) return;
      const state = flipState({ forming: c, secondsLeft, tfSeconds: TF_SECONDS, atr, sd, previous: bars.slice(-3).map((b) => b.candle) });
      if (!state) return;
      try {
        const a = await withTimeout(askFlip(state, `${c.time}:${Math.floor(now / FLIP_SECONDS)}`), 15_000);
        flipCalls += 1;
        lastFlip = { forTime: c.time, move: c.close - c.open, pFlip: a.pFlip, at: Date.now() };
        const math = predictor.live(c, feed.now());
        setFlip({ status: "ok", pFlip: a.pFlip, pMath: math?.pGreen ?? null, at: Date.now(), calls: flipCalls, weights: blender.weights });
        setState((s) => ({ ...s, live: computeLive(c) }));
      } catch (e) {
        setFlip({ status: `error: ${(e as Error).message}` });
      }
    };

    /** Replay Jev's flip read on ~150 recent candles rebuilt partway through, before trusting it live. */
    const flipBackfill = async (preds: Map<number, Prediction>, history: Candle[]) => {
      if (!(feed instanceof LiveFeed)) return setFlip({ status: "needs live data" });
      setFlip({ status: "loading 1-minute history…" });
      const minutes = await feed.minuteHistory(3).catch(() => [] as Candle[]);
      const atrs = atrByTime(history);
      const snaps = pastSnapshots(minutes, history, TF_SECONDS, (t) => atrs.get(t - TF_SECONDS) ?? null, (t) => preds.get(t)?.pFinal ?? 0.5, FLIP_BACKFILL);
      if (snaps.length < 30) return setFlip({ status: "not enough 1-minute history to test the flip check yet" });
      const cache = readFlipCache();
      const rows: FlipRow[] = [];
      let done = 0;
      const lanes = Array.from({ length: 6 }, (_, k) => snaps.filter((_, i) => i % 6 === k));
      const answers = new Map<number, number>();
      await Promise.all(
        lanes.map(async (list) => {
          for (const sn of list) {
            if (cancelled) return;
            let pFlip = cache[String(sn.time)];
            if (pFlip === undefined) {
              try {
                pFlip = (await withTimeout(askFlip(sn.state, `past:${sn.time}`), 30_000)).pFlip;
                cache[String(sn.time)] = pFlip;
                flipCalls += 1;
              } catch {
                continue;
              }
            }
            answers.set(sn.time, pFlip);
            if (++done % 10 === 0) setFlip({ status: `testing Jev's flip read on past candles: ${done} of ${snaps.length}`, calls: flipCalls });
          }
        }),
      );
      writeFlipCache(cache);
      for (const sn of snaps) {
        const pf = answers.get(sn.time);
        if (pf !== undefined) rows.push({ pMath: sn.pMath, pJev: greenFromFlip(sn.move, pf), move: sn.move, y: sn.y });
      }
      if (rows.length < 30) return setFlip({ status: "couldn't test the flip check on enough past candles" });
      setFlip({ status: "ok", backfill: blender.backfill(rows), weights: blender.weights, calls: flipCalls });
      flipReady = true;
      void flipTick();
    };

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
      if (v.features.includes("jev-flip")) await flipBackfill(t.preds, history);
      else setFlip({ status: "waiting for the new backend: ask Lovable to “Deploy the gold edge function”" });
    };

    const onClose = async (c: Candle) => {
      if (halfwayFlip && halfwayFlip.forTime === c.time && c.close !== c.open) {
        setFlip({ live: blender.recordLive({ ...halfwayFlip, y: c.close > c.open ? 1 : 0 }), weights: blender.weights });
        halfwayFlip = null;
      }
      lastFlip = null;
      setFlip({ pFlip: null, at: null });
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
            const live = computeLive(c);
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
      const live = computeLive(lastForming);
      setState((s) => ({ ...s, live }));
    }, 1000);
    const flipClock = window.setInterval(() => void flipTick(), FLIP_SECONDS * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(clock);
      window.clearInterval(flipClock);
      stop?.();
    };
  }, []);

  return state;
}
