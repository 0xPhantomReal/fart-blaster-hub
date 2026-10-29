// Next-candle predictor: will the next 15-minute candle close green or red?
//
//   model  — online logistic regression on short-term, scale-free features, trained walk-forward
//            (every prediction is made before that candle's outcome is seen)
//   Jev    — its own green/red read from the same clean data, plus a fact-check score of the model's call
//   final  — model and Jev blended by their track records; only called when the fact-check supports it
//
// Every source keeps an out-of-sample record, so the page can say how accurate each one really is.

import { Ema, Rma, type Candle } from "./indicators";

// ── Features: what the last 1–3 candles did, in ATR units ──────────────

export const FEATURES = [
  "last_candle_body",
  "big_candle_x_direction",
  "close_position_in_candle",
  "wick_pressure",
  "candle_before_body",
  "two_candles_back_body",
  "two_candle_move",
  "close_vs_last_3_middle",
  "broke_previous_high",
  "broke_previous_low",
  "fast_rsi_5",
  "streak",
  "distance_from_ema5",
  "time_of_day_sin",
  "time_of_day_cos",
] as const;
const N = FEATURES.length;

const clip = (x: number, a = 4) => Math.max(-a, Math.min(a, x));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return Math.log(q / (1 - q));
};
const r2 = (v: number) => Number(v.toFixed(2));

class FeatureBuilder {
  private ema5 = new Ema(5);
  private up = new Rma(5);
  private dn = new Rma(5);
  private atrR = new Rma(14);
  private hist: Candle[] = [];
  private streak = 0;
  private prevAtr: number | null = null;
  atr: number | null = null;

  push(c: Candle): number[] | null {
    const prev = this.hist[this.hist.length - 1];
    const tr = prev ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)) : c.high - c.low;
    let rsi: number | null = null;
    if (prev) {
      const ch = c.close - prev.close;
      const u = this.up.update(Math.max(ch, 0));
      const d = this.dn.update(Math.max(-ch, 0));
      if (u !== null && d !== null) rsi = d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
    }
    const atrPrev = this.prevAtr;
    const atr = this.atrR.update(tr);
    this.prevAtr = atr;
    this.atr = atr;
    const e5 = this.ema5.update(c.close);
    this.hist.push(c);
    if (this.hist.length > 4) this.hist.shift();
    const body = c.close - c.open;
    const rng = c.high - c.low;
    this.streak = body > 0 ? (this.streak > 0 ? this.streak + 1 : 1) : body < 0 ? (this.streak < 0 ? this.streak - 1 : -1) : 0;
    if (atr === null || atrPrev === null || e5 === null || rsi === null || this.hist.length < 4 || atr <= 0 || atrPrev <= 0) return null;

    const [, c2, c1] = this.hist.slice(-4, -1) as [Candle, Candle, Candle];
    const upW = c.high - Math.max(c.open, c.close);
    const loW = Math.min(c.open, c.close) - c.low;
    const last3 = [c2, c1, c];
    const mid3 = (Math.max(...last3.map((k) => k.high)) + Math.min(...last3.map((k) => k.low))) / 2;
    const d = new Date(c.time * 1000);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    return [
      clip(body / atrPrev),
      clip((rng / atrPrev - 1) * Math.sign(body)),
      rng > 0 ? (c.close - c.low) / rng - 0.5 : 0,
      rng > 0 ? (loW - upW) / rng : 0,
      clip((c1.close - c1.open) / atr),
      clip((c2.close - c2.open) / atr),
      clip((c.close - c2.close) / atr),
      clip((c.close - mid3) / atr),
      clip(Math.max(0, c.close - c1.high) / atr),
      clip(Math.max(0, c1.low - c.close) / atr),
      (rsi - 50) / 50,
      clip(this.streak, 6) / 6,
      clip((c.close - e5) / atr),
      Math.sin((2 * Math.PI * hour) / 24),
      Math.cos((2 * Math.PI * hour) / 24),
    ];
  }
}

// ── Learner: logistic regression with a ~3-week memory ────────────────

class OnlineLogit {
  private w = new Array(N).fill(0);
  private b = 0;
  private G = new Array(N).fill(1e-8);
  private Gb = 1e-8;
  private mean = new Array(N).fill(0);
  private vari = new Array(N).fill(1);
  private seen = 0;
  updates = 0;
  constructor(
    private lr = 0.002,
    private l2 = 1e-3,
    private memory = 2000,
  ) {}
  private z(x: number[]) {
    if (this.seen < 10) return x.map(() => 0);
    return x.map((v, i) => clip((v - this.mean[i]) / Math.sqrt(this.vari[i] + 1e-9), 5));
  }
  predict(x: number[]) {
    const z = this.z(x);
    return sigmoid(this.b + z.reduce((a, v, i) => a + v * this.w[i], 0));
  }
  update(x: number[], y: 0 | 1) {
    const z = this.z(x);
    const g = sigmoid(this.b + z.reduce((a, v, i) => a + v * this.w[i], 0)) - y;
    const rho = 1 - 1 / this.memory;
    for (let i = 0; i < N; i++) {
      const gi = g * z[i] + this.l2 * this.w[i];
      this.G[i] = rho * this.G[i] + (1 - rho) * gi * gi;
      this.w[i] -= (this.lr * gi) / Math.sqrt(this.G[i] + 1e-8);
    }
    this.Gb = rho * this.Gb + (1 - rho) * g * g;
    this.b -= (this.lr * g) / Math.sqrt(this.Gb + 1e-8);
    this.observe(x);
    this.updates += 1;
  }
  observe(x: number[]) {
    this.seen += 1;
    const a = Math.max(1 / this.seen, 1 / this.memory);
    for (let i = 0; i < N; i++) {
      const delta = x[i] - this.mean[i];
      this.mean[i] += a * delta;
      this.vari[i] = (1 - a) * (this.vari[i] + a * delta * delta);
    }
  }
}

/** Learns how much to trust the model vs Jev, from who has actually been right. */
export class Stacker {
  wModel = 1;
  wJev = 0.5;
  bias = 0;
  updates = 0;
  predict(pm: number, pj: number) {
    return sigmoid(this.wModel * logit(pm) + this.wJev * logit(pj) + this.bias);
  }
  update(pm: number, pj: number, y: 0 | 1, lr = 0.02) {
    const g = this.predict(pm, pj) - y;
    this.wModel -= lr * g * logit(pm);
    this.wJev -= lr * g * logit(pj);
    this.bias -= lr * g;
    this.updates += 1;
  }
}

// ── Scorekeeping ──────────────────────────────────────────────────────

export interface TrackRecord {
  n: number; //             candles scored
  calls: number; //         candles where it made a call
  hitRate: number | null; // share of calls that were right
  skill: number | null; //  Brier skill vs the running base rate; above 0 = real information
}

export class Tracker {
  private n = 0;
  private greens = 0;
  private brier = 0;
  private brierBase = 0;
  private calls = 0;
  private hits = 0;
  /** `call`: −1 red, +1 green, 0 no call. */
  record(p: number, call: -1 | 0 | 1, y: 0 | 1) {
    const base = this.n > 0 ? this.greens / this.n : 0.5;
    this.brier += (p - y) ** 2;
    this.brierBase += (base - y) ** 2;
    this.n += 1;
    this.greens += y;
    if (call !== 0) {
      this.calls += 1;
      if ((call === 1) === (y === 1)) this.hits += 1;
    }
  }
  summary(): TrackRecord {
    return {
      n: this.n,
      calls: this.calls,
      hitRate: this.calls ? this.hits / this.calls : null,
      skill: this.n && this.brierBase > 0 ? 1 - this.brier / this.brierBase : null,
    };
  }
}

// ── Predictor ─────────────────────────────────────────────────────────

/** Jev's answers for one candle: its own chance of green, and how well the evidence supports the model's call (0–3). */
export interface JevAnswer {
  pGreen: number;
  support: number | null; // null when the model made no call (nothing to fact-check)
}

export interface Prediction {
  forTime: number; //     open time of the candle being predicted
  pModel: number | null;
  modelCall: -1 | 0 | 1;
  jev: JevAnswer | null;
  pFinal: number | null;
  call: -1 | 0 | 1; //    final call
  blockedByCheck: boolean; // the model had a call but Jev's fact-check didn't support it
}

export interface Outcome {
  call: -1 | 0 | 1;
  hit: boolean | null; // null when no call or a doji
}

/** Fact-check score needed for the final call to stand (2 = "evidence mostly supports the call"). */
export const SUPPORT_NEEDED = 1.5;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function normCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Live read of the candle forming now. */
export interface Live {
  pGreen: number; //      chance it closes green, given the open forecast and what it has done so far
  call: -1 | 0 | 1;
  move: number; //        close − open so far
  timeLeftFrac: number; // 1 at the open, 0 at the close
}

export class Predictor {
  private features = new FeatureBuilder();
  private model = new OnlineLogit();
  private stacker = new Stacker();
  private recent: Candle[] = [];
  private pending: (Prediction & { x: number[] | null; counted: boolean }) | null = null;
  private snapshots = new Map<number, JevSnapshot>();
  readonly track = { model: new Tracker(), jev: new Tracker(), final: new Tracker(), halfway: new Tracker() };
  private halfway: { forTime: number; p: number } | null = null; // live read captured at the candle's midpoint

  constructor(
    readonly tfSeconds: number,
    readonly edge = 0.55, //     call only when P(green) ≥ edge or ≤ 1 − edge
    readonly warmup = 300, //    candles learned before predictions count
    readonly keepSnapshots = 200, // remember Jev snapshots for the latest candles (for the Jev backfill)
  ) {}

  get warm() {
    return this.model.updates >= this.warmup;
  }
  get atr() {
    return this.features.atr;
  }

  private callFor(p: number | null): -1 | 0 | 1 {
    if (p === null || !this.warm) return 0;
    return p >= this.edge ? 1 : p <= 1 - this.edge ? -1 : 0;
  }

  /** Score the pending prediction against candle `c`, learn from it, and predict the next candle. */
  close(c: Candle): { outcome: Outcome | null; next: Prediction } {
    let outcome: Outcome | null = null;
    const p = this.pending;
    if (p) {
      const y: 0 | 1 | null = c.close > c.open ? 1 : c.close < c.open ? 0 : null;
      if (y !== null) {
        if (p.counted && p.pModel !== null) this.track.model.record(p.pModel, p.modelCall, y);
        if (p.counted && p.jev) this.track.jev.record(p.jev.pGreen, this.callFor(p.jev.pGreen), y);
        if (p.counted && p.pFinal !== null) this.track.final.record(p.pFinal, p.call, y);
        if (p.pModel !== null && p.jev) this.stacker.update(p.pModel, p.jev.pGreen, y);
        if (p.counted && this.halfway && this.halfway.forTime === p.forTime) {
          const hp = this.halfway.p;
          this.track.halfway.record(hp, this.callFor(hp), y);
        }
        if (p.x) this.model.update(p.x, y);
      } else if (p.x) this.model.observe(p.x);
      outcome = { call: p.call, hit: p.call === 0 || y === null ? null : (p.call === 1) === (y === 1) };
    }
    this.recent.push(c);
    if (this.recent.length > 100) this.recent.shift();

    const x = this.features.push(c);
    const pModel = x ? this.model.predict(x) : null;
    const modelCall = this.callFor(pModel);
    const forTime = c.time + this.tfSeconds;
    this.pending = { forTime, x, pModel, modelCall, jev: null, pFinal: pModel, call: modelCall, blockedByCheck: false, counted: this.warm && pModel !== null };

    if (x && this.warm) {
      const snap = this.buildSnapshot(x, pModel, modelCall);
      if (snap) {
        this.snapshots.set(forTime, snap);
        if (this.snapshots.size > this.keepSnapshots) this.snapshots.delete(this.snapshots.keys().next().value!);
      }
    }
    return { outcome, next: this.view() };
  }

  /**
   * Live chance the forming candle closes green, recomputed on every tick and every second. It starts at the
   * open forecast and then follows the candle: the move so far against how far price typically still travels
   * in the time left (recent candle bodies, scaled by the square root of time left).
   */
  live(f: Candle, nowSec: number): Live | null {
    const p = this.pending;
    if (!p || f.time !== p.forTime) return null;
    const bodies = this.recent.slice(-100).map((c) => c.close - c.open);
    if (bodies.length < 30) return null;
    const mean = bodies.reduce((a, v) => a + v, 0) / bodies.length;
    const sd = Math.sqrt(bodies.reduce((a, v) => a + (v - mean) ** 2, 0) / (bodies.length - 1));
    if (!(sd > 0)) return null;
    const frac = Math.min(1, Math.max(0.005, (f.time + this.tfSeconds - nowSec) / this.tfSeconds));
    const prior = p.pFinal ?? 0.5;
    const drift = sd * (logit(prior) / 1.702) * frac; // the open forecast's lean, fading as time runs out
    const move = f.close - f.open;
    const raw = normCdf((move + drift) / (sd * Math.sqrt(frac)));
    const pGreen = Math.min(0.99, Math.max(0.01, raw));
    if (frac <= 0.5 && (!this.halfway || this.halfway.forTime !== f.time)) this.halfway = { forTime: f.time, p: pGreen };
    return { pGreen, call: this.callFor(pGreen), move, timeLeftFrac: frac };
  }

  /** Fold in Jev's answers for the pending candle. */
  applyJev(a: JevAnswer): Prediction | null {
    const p = this.pending;
    if (!p || p.pModel === null) return null;
    p.jev = a;
    p.pFinal = this.stacker.predict(p.pModel, a.pGreen);
    const call = this.callFor(p.pFinal);
    p.blockedByCheck = call !== 0 && a.support !== null && a.support < SUPPORT_NEEDED;
    p.call = p.blockedByCheck ? 0 : call;
    return this.view();
  }

  /**
   * Jev on past candles (oldest first), scored against what happened. Trains the stacker and gives Jev
   * a measured record before it is used live. Each row needs the model's prediction from that time.
   */
  backfill(rows: { pModel: number; jev: JevAnswer; y: 0 | 1 }[]) {
    const t = { model: new Tracker(), jev: new Tracker(), final: new Tracker() };
    for (const r of rows) {
      const pf = this.stacker.predict(r.pModel, r.jev.pGreen);
      const fc = this.callFor(pf);
      const blocked = fc !== 0 && r.jev.support !== null && r.jev.support < SUPPORT_NEEDED;
      t.model.record(r.pModel, this.callFor(r.pModel), r.y);
      t.jev.record(r.jev.pGreen, this.callFor(r.jev.pGreen), r.y);
      t.final.record(pf, blocked ? 0 : fc, r.y);
      this.stacker.update(r.pModel, r.jev.pGreen, r.y);
    }
    return { model: t.model.summary(), jev: t.jev.summary(), final: t.final.summary() };
  }

  /** The Jev snapshot saved for the candle opening at `forTime` (latest ~200 candles only). */
  snapshotFor(forTime: number): JevSnapshot | undefined {
    return this.snapshots.get(forTime);
  }

  private view(): Prediction {
    const { x: _x, counted: _c, ...rest } = this.pending!;
    void _x;
    void _c;
    return { ...rest };
  }

  /** Clean data for Jev: recent candles and named signals in ATR units, plus the model's call and record. */
  private buildSnapshot(x: number[], pModel: number | null, modelCall: -1 | 0 | 1): JevSnapshot | null {
    const atr = this.features.atr;
    const rc = this.recent;
    if (!atr || rc.length < 16) return null;
    const describe = (c: Candle) => ({
      c: c.close > c.open ? "G" : c.close < c.open ? "R" : "D",
      body: r2((c.close - c.open) / atr),
      range: r2((c.high - c.low) / atr),
      close_at: c.high > c.low ? r2((c.close - c.low) / (c.high - c.low)) : 0.5,
      up_wick: r2((c.high - Math.max(c.open, c.close)) / atr),
      dn_wick: r2((Math.min(c.open, c.close) - c.low) / atr),
    });
    const hourly: Candle[] = [];
    for (const c of rc) {
      const b = Math.floor(c.time / 3600) * 3600;
      const cur = hourly[hourly.length - 1];
      if (cur && cur.time === b) {
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
      } else hourly.push({ ...c, time: b });
    }
    const last = rc[rc.length - 1];
    const h = new Date((last.time + this.tfSeconds) * 1000).getUTCHours();
    const m = this.track.model.summary();
    return {
      data: {
        how_to_read:
          "c = color (G/R/D). body (signed), range and wicks in ATR units; close_at 0 = closed at the low, 1 = at the high. Lists are oldest first.",
        session_of_next_candle:
          h >= 13 && h < 16 ? "London/New York overlap" : h >= 7 && h < 13 ? "London" : h >= 16 && h < 21 ? "New York" : "Asia / quiet hours",
        candles_15m_last_12: rc.slice(-12).map(describe),
        candles_1h_last_4: hourly.slice(-4).map(describe),
        signals: Object.fromEntries(FEATURES.slice(0, 13).map((name, i) => [name, r2(x[i])])),
      },
      model: {
        p_green: pModel === null ? null : r2(pModel),
        call: modelCall === 1 ? "green" : modelCall === -1 ? "red" : "none",
        record: {
          hit_rate_pct: m.hitRate === null ? null : Math.round(m.hitRate * 100),
          calls: m.calls,
          skill: m.skill === null ? null : Number(m.skill.toFixed(3)),
        },
      },
    };
  }

  summary() {
    return {
      warm: this.warm,
      model: this.track.model.summary(),
      jev: this.track.jev.summary(),
      final: this.track.final.summary(),
      halfway: this.track.halfway.summary(),
      trust: this.stacker.updates ? { model: this.stacker.wModel, jev: this.stacker.wJev } : null,
    };
  }
}

/** What Jev sees: `data` for its own call, plus `model` for the fact-check. */
export interface JevSnapshot {
  data: { [k: string]: unknown };
  model: { p_green: number | null; call: "green" | "red" | "none"; record: { hit_rate_pct: number | null; calls: number; skill: number | null } };
}
