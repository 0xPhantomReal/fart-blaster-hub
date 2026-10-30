import { useEffect, useRef, useState } from "react";
import type { Candle } from "./indicators";
import { Predictor, type JevAnswer, type Live, type Outcome, type Prediction, type TrackRecord } from "./predictor";
import { AnalogPool, HORIZON, label, scorePath, toCandles, PathTally, type Path, type PathRecord } from "./forecast";
import { atrByTime, bodySd, FlipBlender, flipState, greenFromFlip, pastSnapshots, type FlipRecords, type FlipRow } from "./flip";
import {
  askCheck,
  askFlip,
  askForecast,
  backendConfigured,
  backendVersion,
  LiveFeed,
  SimFeed,
  tickCheck,
  type Feed,
  type Market,
  type Timeframe,
  type TickCheck,
  type TickStatus,
} from "./feed";

/** How many recent past candles Jev is checked on before it is used live. */
export const BACKFILL = 200;
/** How many past candles Jev's flip read is replayed on (rebuilt partway through from 1-minute data). */
export const FLIP_BACKFILL = 150;
/** How often Jev re-reads the forming candle. */
export const FLIP_SECONDS = 3;

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

/** The 5-candle bar forecast from the last close. */
export interface ForecastView {
  status: string;
  candles: Candle[] | null; //  the path drawn on the chart (starts at the candle forming now)
  source: "jev" | "typical" | null; // Jev's pick of the paths, or the most typical path
  endsHigherPct: number | null; //    share of the 50 paths that end above the last close
  pickedPct: number | null; //        Jev's probability for its pick
  replay: PathRecord | null; //       the typical path, replayed on recent past candles
  live: { jev: PathRecord; typical: PathRecord } | null;
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
  forecast: ForecastView;
  /** Set when this market can't be shown yet (the page shows this instead of a chart). */
  blocked: string | null;
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
// One store per market and timeframe (gold 15m keeps its original name so its answers carry over).
type Where = { market: Market; tf: number };
const tfKey = (base: string, w: Where) =>
  w.market === "gold" ? (w.tf === 15 ? base : `${base}.${w.tf}m`) : `${base}.${w.market}.${w.tf}m`;
function readCache(w: Where): Record<string, JevAnswer> {
  try {
    return JSON.parse(localStorage.getItem(tfKey("gold.jevcheck.v1", w)) ?? "{}");
  } catch {
    return {};
  }
}
function writeCache(c: Record<string, JevAnswer>, w: Where) {
  try {
    const keys = Object.keys(c).sort();
    const trimmed = Object.fromEntries(keys.slice(-600).map((k) => [k, c[k]]));
    localStorage.setItem(tfKey("gold.jevcheck.v1", w), JSON.stringify(trimmed));
  } catch {
    // storage unavailable: answers are just fetched again next visit
  }
}

function readFlipCache(w: Where): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(tfKey("gold.flipcheck.v1", w)) ?? "{}");
  } catch {
    return {};
  }
}
function writeFlipCache(c: Record<string, number>, w: Where) {
  try {
    const keys = Object.keys(c).sort();
    localStorage.setItem(tfKey("gold.flipcheck.v1", w), JSON.stringify(Object.fromEntries(keys.slice(-500).map((k) => [k, c[k]]))));
  } catch {
    // fine: fetched again next visit
  }
}

const FLIP_START = { status: "starting…", pFlip: null, pMath: null, at: null, backfill: null, live: null, weights: null, calls: 0 };
const FORECAST_START: ForecastView = { status: "waiting for history…", candles: null, source: null, endsHigherPct: null, pickedPct: null, replay: null, live: null, calls: 0 };

/**
 * Everything on the /gold page for one timeframe. Switching timeframe starts over (fresh history, model, Jev
 * checks). `forecastOn` only controls whether Jev is asked to pick the forecast path (the typical path is free).
 */
export function useGold(market: Market, tfMin: Timeframe, forecastOn: boolean): GoldState {
  const forecastOnRef = useRef(forecastOn);
  const kickForecast = useRef<(() => void) | null>(null);
  useEffect(() => {
    forecastOnRef.current = forecastOn;
    if (forecastOn) kickForecast.current?.();
  }, [forecastOn]);

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
    flip: FLIP_START,
    forecast: FORECAST_START,
    blocked: null,
    version: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const TF_SECONDS = tfMin * 60;
    const where: Where = { market, tf: tfMin };
    let feed: Feed = backendConfigured() ? new LiveFeed(market, tfMin) : new SimFeed(market, tfMin);
    let predictor = new Predictor(TF_SECONDS);
    setState((s) => ({
      ...s,
      status: "loading",
      error: null,
      bars: [],
      forming: null,
      prediction: null,
      live: null,
      walkForward: null,
      backfill: null,
      liveRecord: null,
      trust: null,
      jev: { on: false, status: "starting…", calls: 0 },
      flip: FLIP_START,
      forecast: FORECAST_START,
      blocked: null,
      version: s.version + 1,
    }));
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
        const a = await withTimeout(askCheck(snap, pred.forTime, tfMin, market), 20_000);
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
      const cache = readCache(where);
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
              const a = await withTimeout(askCheck(predictor.snapshotFor(c.time), c.time, tfMin, market), 30_000);
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
      writeCache(cache, where);
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
      const fresh = lastFlip && lastFlip.forTime === c.time && Date.now() - lastFlip.at < 10_000 && move !== 0;
      if (!fresh) return { ...math, pMath: math.pGreen };
      const pJev = greenFromFlip(move, lastFlip!.pFlip);
      const pGreen = blender.blend(math.pGreen, pJev);
      // Keep one mid-candle sample per candle for scoring the flip check.
      if (math.timeLeftFrac <= 0.5 && (!halfwayFlip || halfwayFlip.forTime !== c.time)) halfwayFlip = { forTime: c.time, pMath: math.pGreen, pJev, move };
      return { ...math, pMath: math.pGreen, pGreen, call: pGreen >= 0.55 ? 1 : pGreen <= 0.45 ? -1 : 0 };
    };

    /** Ask Jev about the forming candle (every FLIP_SECONDS; shared per slot by all viewers). */
    let flipBusy = false;
    let lastAsked: { key: string; at: number } | null = null;
    const flipTick = async () => {
      const c = lastForming;
      if (cancelled || !flipReady || !c || document.hidden || flipBusy) return;
      const now = feed.now();
      const secondsLeft = c.time + TF_SECONDS - now;
      const atr = predictor.atr;
      const sd = bodySd(bars.map((b) => b.candle));
      const edge = Math.min(30, TF_SECONDS * 0.1); // skip the very start and end of the candle
      if (secondsLeft < edge || secondsLeft > TF_SECONDS - edge || !atr || !sd) return;
      const state = flipState({ forming: c, secondsLeft, tfSeconds: TF_SECONDS, atr, sd, previous: bars.slice(-3).map((b) => b.candle) });
      if (!state) return;
      // Only fresh data: if the candle's shape hasn't changed since the last ask, don't pay for the same answer
      // again (re-ask at least every 15 s, since the time left still matters).
      const shape = `${c.time}|${state.move_so_far}|${state.high_so_far}|${state.low_so_far}|${state.pulled_back_from_extreme}`;
      if (lastAsked && lastAsked.key === shape && Date.now() - lastAsked.at < 15_000) {
        if (lastFlip && lastFlip.forTime === c.time) {
          lastFlip.at = Date.now(); // same candle shape, so the last answer is still current
          setFlip({ at: lastFlip.at });
        }
        return;
      }
      flipBusy = true;
      try {
        const a = await withTimeout(askFlip(state, `${c.time}:${Math.floor(now / FLIP_SECONDS)}`, tfMin, market), 15_000);
        lastAsked = { key: shape, at: Date.now() };
        flipCalls += 1;
        lastFlip = { forTime: c.time, move: c.close - c.open, pFlip: a.pFlip, at: Date.now() };
        const math = predictor.live(c, feed.now());
        setFlip({ status: "ok", pFlip: a.pFlip, pMath: math?.pGreen ?? null, at: Date.now(), calls: flipCalls, weights: blender.weights });
        setState((s) => ({ ...s, live: computeLive(c) }));
      } catch (e) {
        setFlip({ status: `error: ${(e as Error).message}` });
      } finally {
        flipBusy = false;
      }
    };

    /** Replay Jev's flip read on ~150 recent candles rebuilt partway through, before trusting it live. */
    const flipBackfill = async (preds: Map<number, Prediction>, history: Candle[]) => {
      if (!(feed instanceof LiveFeed)) return setFlip({ status: "needs live data" });
      if (tfMin === 1) {
        // A 1-minute candle can't be rebuilt partway through from 1-minute data, so there's nothing to replay:
        // Jev starts at half weight and is scored live only.
        setFlip({ status: "ok", backfill: null, weights: blender.weights, calls: flipCalls });
        flipReady = true;
        return void flipTick();
      }
      setFlip({ status: "loading 1-minute history…" });
      const minutes = await feed.minuteHistory(3).catch(() => [] as Candle[]);
      const atrs = atrByTime(history);
      const snaps = pastSnapshots(minutes, history, TF_SECONDS, (t) => atrs.get(t - TF_SECONDS) ?? null, (t) => preds.get(t)?.pFinal ?? 0.5, FLIP_BACKFILL);
      if (snaps.length < 30) return setFlip({ status: "not enough 1-minute history to test the flip check yet" });
      const cache = readFlipCache(where);
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
                pFlip = (await withTimeout(askFlip(sn.state, `past:${sn.time}`, tfMin, market), 30_000)).pFlip;
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
      writeFlipCache(cache, where);
      for (const sn of snaps) {
        const pf = answers.get(sn.time);
        if (pf !== undefined) rows.push({ pMath: sn.pMath, pJev: greenFromFlip(sn.move, pf), move: sn.move, y: sn.y });
      }
      if (rows.length < 30) return setFlip({ status: "couldn't test the flip check on enough past candles" });
      setFlip({ status: "ok", backfill: blender.backfill(rows), weights: blender.weights, calls: flipCalls });
      flipReady = true;
      void flipTick();
    };

    // ── Bar forecast: the next 5 candles, from look-alike moments in history ──
    let pool: AnalogPool | null = null;
    let poolHistory: Candle[] = [];
    let features: string[] = [];
    let forecastCalls = 0;
    const tallies = { jev: new PathTally(), typical: new PathTally() };
    let pending: { startTime: number; startPrice: number; typical: Path; jev: Path | null }[] = [];
    let shown: { startTime: number; startPrice: number; atr: number; paths: Path[]; options: Record<string, string> } | null = null;
    const setForecast = (patch: Partial<ForecastView>) => !cancelled && setState((s) => ({ ...s, forecast: { ...s.forecast, ...patch } }));
    const jevCanPick = () => feed.jev && features.includes("jev-forecast");

    const draw = (p: Path, source: "jev" | "typical", pickedPct: number | null) => {
      if (!shown) return;
      setForecast({ candles: toCandles(p, shown.startTime, shown.startPrice, shown.atr, TF_SECONDS), source, pickedPct });
    };

    /** Ask Jev once per candle which path is most likely (only while the forecast is switched on). */
    const pickWithJev = async () => {
      const f = shown;
      if (!f || cancelled || !forecastOnRef.current || !jevCanPick()) return;
      const pend = pending.find((p) => p.startTime === f.startTime);
      if (!pend || pend.jev) return;
      const snap = predictor.snapshotFor(f.startTime);
      if (!snap) return;
      setForecast({ status: "Jev is picking the most likely path…" });
      try {
        const a = await withTimeout(askForecast(snap.data, f.options, f.startTime, tfMin, market), 30_000);
        forecastCalls += 1;
        const pick = f.paths.find((p) => p.id === a.choice);
        if (!pick) throw new Error("unknown pick");
        pend.jev = pick;
        if (shown === f) draw(pick, "jev", a.probabilities[a.choice] ?? null);
        setForecast({ status: "ok", calls: forecastCalls });
      } catch (e) {
        setForecast({ status: `Jev couldn't pick (${(e as Error).message}); showing the most typical path`, calls: forecastCalls });
      }
    };
    kickForecast.current = () => void pickWithJev();

    /** New forecast from the last close: draw the typical path now, then let Jev pick. */
    const makeForecast = () => {
      const set = pool?.paths();
      const last = poolHistory[poolHistory.length - 1];
      if (!set || !last) return setForecast({ status: "not enough history for a forecast yet" });
      shown = {
        startTime: last.time + TF_SECONDS,
        startPrice: last.close,
        atr: set.atr,
        paths: set.paths,
        options: Object.fromEntries(set.paths.map((p) => [p.id, label(p)])),
      };
      pending.push({ startTime: shown.startTime, startPrice: shown.startPrice, typical: set.typical, jev: null });
      if (pending.length > 20) pending.shift();
      draw(set.typical, "typical", null);
      setForecast({
        endsHigherPct: set.endsHigherPct,
        status: jevCanPick() ? (forecastOnRef.current ? "ok" : "Jev picks when the forecast is on") : feed.jev ? "waiting for the new backend" : "ok",
      });
      void pickWithJev();
    };

    /** Score forecasts whose 5 candles have all closed. */
    const scoreForecasts = () => {
      pending = pending.filter((p) => {
        const after: Candle[] = [];
        for (let k = poolHistory.length - 1; k >= 0 && poolHistory[k].time >= p.startTime; k--) after.unshift(poolHistory[k]);
        if (after.length < HORIZON) return true;
        const actual = after.slice(0, HORIZON);
        tallies.typical.add(scorePath(p.typical, actual, p.startPrice));
        if (p.jev) tallies.jev.add(scorePath(p.jev, actual, p.startPrice));
        setForecast({ live: { jev: tallies.jev.summary(), typical: tallies.typical.summary() } });
        return false;
      });
    };

    /** Rebuild the analog pool on `history`, replay the typical path on the last 200 candles, forecast. */
    const buildForecast = (history: Candle[]) => {
      poolHistory = [...history];
      pool = new AnalogPool(poolHistory, TF_SECONDS);
      const replay = new PathTally();
      for (let i = Math.max(60, poolHistory.length - 200 - HORIZON); i < poolHistory.length - HORIZON; i++) {
        const set = pool.paths(i);
        if (set) replay.add(scorePath(set.typical, poolHistory.slice(i + 1, i + 1 + HORIZON), poolHistory[i].close));
      }
      setForecast({ replay: replay.summary() });
      makeForecast();
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
      buildForecast(history);
      return t;
    };

    /** Once training is final: check Jev on recent past candles, then use it live. Runs outside the candle queue. */
    const hookJev = async (t: ReturnType<typeof train>, history: Candle[]) => {
      if (!feed.jev) return setJev({ on: false, status: "off (no TypeSafe key on the backend)" });
      setJev({ on: true });
      const v = await backendVersion().catch(() => null);
      features = v?.features ?? [];
      void pickWithJev();
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
      if (!poolHistory.length || c.time > poolHistory[poolHistory.length - 1].time) {
        poolHistory.push(c);
        pool = new AnalogPool(poolHistory, TF_SECONDS);
        scoreForecasts();
        makeForecast();
      }
      bars.push({ candle: c, outcome });
      if (bars.length > MAX_BARS) bars.shift();
      current = next;
      lastForming = null;
      setState((s) => ({ ...s, bars: [...bars], forming: null, prediction: next, live: null, liveRecord: liveRecord() }));
      setState((s) => ({ ...s, version: s.version + 1 }));
      await consult(next);
    };

    (async () => {
      // An older backend ignores the market and sends gold. Don't show gold under a bitcoin label.
      if (market !== "gold" && feed instanceof LiveFeed) {
        const v = await backendVersion().catch(() => null);
        if (cancelled) return;
        if (!v || !v.features.includes("markets")) {
          set({
            status: "ready",
            blocked:
              "The deployed backend only knows gold, so it sent gold candles. In Lovable, type “Deploy the gold edge function”, then reload this page.",
          });
          return;
        }
      }
      let history: Candle[];
      try {
        history = await feed.history();
      } catch (e) {
        feed = new SimFeed(market, tfMin);
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
          .deepHistory()
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
              .then((v) => (v?.features.includes("tickcheck") ? tickCheck(market) : null))
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
      kickForecast.current = null;
      stop?.();
    };
  }, [market, tfMin]);

  return state;
}
