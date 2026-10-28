// Quant engine: scale-free features → online logistic regression → (optional) Jev blend.
// Strict walk-forward: every prediction is made before the model sees that candle's outcome.

import { Ema, Rma, type Candle } from "./indicators";
import { reversionAt, type ReversionFit } from "./reversion";

// ── Features ──────────────────────────────────────────────────────────

export const FEATURES = [
  "Last candle body", //               signed body ÷ prior ATR
  "Big candle × direction", //         (range ÷ prior ATR − 1) × sign(body): the big-candle fade
  "Close position in candle", //       0 = at low, 1 = at high (centred)
  "Wick pressure", //                  (lower wick − upper wick) ÷ range
  "Candle before body", //             signed body of candle −2
  "Two candles back body", //          signed body of candle −3
  "2-candle move", //                  ATR units
  "Close vs last 3 candles' middle", // short-term stretch
  "Broke previous high", //            close above prior candle's high (ATR units, ≥ 0)
  "Broke previous low", //             close below prior candle's low (ATR units, ≥ 0)
  "Fast RSI (5)", //                   centred, −1…1
  "Streak", //                         −1…1
  "Distance from 5-candle EMA", //     ATR units
  "Time of day",
  "Time of day ",
] as const;
export const N_FEATURES = FEATURES.length;

const clip = (x: number, a = 4) => Math.max(-a, Math.min(a, x));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return Math.log(q / (1 - q));
};

/** Short-horizon features: almost everything looks at the last 1–3 candles. */
export class FeatureBuilder {
  private ema5 = new Ema(5);
  private up = new Rma(5);
  private dn = new Rma(5);
  private atrR = new Rma(14);
  private hist: Candle[] = [];
  private streak = 0;
  private prevAtr: number | null = null;
  atr: number | null = null;

  /** Features describing the market once candle `c` has closed, or null while warming up. */
  push(c: Candle): number[] | null {
    const prev = this.hist.length ? this.hist[this.hist.length - 1] : undefined;
    const tr = prev
      ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
      : c.high - c.low;
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

    if (atr === null || atrPrev === null || e5 === null || rsi === null || this.hist.length < 4 || atr <= 0 || atrPrev <= 0) {
      return null;
    }

    const [c3, c2, c1] = this.hist.slice(-4, -1) as [Candle, Candle, Candle]; // 3, 2 and 1 candles before c
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

// ── Online logistic regression with a short memory ───────────────────
// RMSProp-style steps and exponentially-weighted scaling, so recent candles
// count most and the model keeps adapting instead of freezing on old history.

export class OnlineLogit {
  readonly w: number[];
  private b = 0;
  private G: number[];
  private Gb = 1e-8;
  private mean: number[];
  private vari: number[];
  private seen = 0;
  updates = 0;

  constructor(
    private dim: number,
    private lr = 0.002,
    private l2 = 1e-3,
    private memory = 2000, // candles (~3 weeks of 15m): how far back the model "remembers"
  ) {
    this.w = new Array(dim).fill(0);
    this.G = new Array(dim).fill(1e-8);
    this.mean = new Array(dim).fill(0);
    this.vari = new Array(dim).fill(1);
  }

  private z(x: number[]): number[] {
    if (this.seen < 10) return x.map(() => 0);
    return x.map((v, i) => clip((v - this.mean[i]!) / Math.sqrt(this.vari[i]! + 1e-9), 5));
  }

  predict(x: number[]): number {
    const z = this.z(x);
    let s = this.b;
    for (let i = 0; i < this.dim; i++) s += this.w[i]! * z[i]!;
    return sigmoid(s);
  }

  /** How much each feature pushed the current prediction (log-odds units). */
  contributions(x: number[]): number[] {
    const z = this.z(x);
    return z.map((v, i) => v * this.w[i]!);
  }

  /** Learn from (x, outcome), then fold x into the running scaler. */
  update(x: number[], y: 0 | 1): void {
    const z = this.z(x);
    let s = this.b;
    for (let i = 0; i < this.dim; i++) s += this.w[i]! * z[i]!;
    const g = sigmoid(s) - y;
    const rho = 1 - 1 / this.memory;
    for (let i = 0; i < this.dim; i++) {
      const gi = g * z[i]! + this.l2 * this.w[i]!;
      this.G[i] = rho * this.G[i]! + (1 - rho) * gi * gi;
      this.w[i]! -= (this.lr * gi) / Math.sqrt(this.G[i]! + 1e-8);
    }
    this.Gb = rho * this.Gb + (1 - rho) * g * g;
    this.b -= (this.lr * g) / Math.sqrt(this.Gb + 1e-8);
    this.observe(x);
    this.updates += 1;
  }

  /** Update the scaler only (used for doji candles, which teach no direction). */
  observe(x: number[]): void {
    this.seen += 1;
    const a = Math.max(1 / this.seen, 1 / this.memory);
    for (let i = 0; i < this.dim; i++) {
      const delta = x[i]! - this.mean[i]!;
      this.mean[i]! += a * delta;
      this.vari[i] = (1 - a) * (this.vari[i]! + a * delta * delta);
    }
  }
}

// ── Blend model + Jev; learns how much to trust each ─────────────────

export class Stacker {
  wModel = 1;
  wJev = 0.5; // prior: Jev counts half until it earns more
  bias = 0;
  updates = 0;
  constructor(private lr = 0.02) {}
  predict(pm: number, pj: number): number {
    return sigmoid(this.wModel * logit(pm) + this.wJev * logit(pj) + this.bias);
  }
  update(pm: number, pj: number, y: 0 | 1): void {
    const g = this.predict(pm, pj) - y;
    this.wModel -= this.lr * g * logit(pm);
    this.wJev -= this.lr * g * logit(pj);
    this.bias -= this.lr * g;
    this.updates += 1;
  }
}

// ── Out-of-sample scorekeeping ────────────────────────────────────────

export interface TrackSummary {
  n: number; //        candles scored
  calls: number; //    candles where it made a call
  hitRate: number | null;
  majority: number | null; // accuracy of always guessing the more common color so far
  skill: number | null; //   Brier skill vs the running base rate: > 0 means real information
}

export class Tracker {
  private n = 0;
  private greens = 0;
  private brier = 0;
  private brierBase = 0;
  private calls = 0;
  private hits = 0;
  private majorityHits = 0;

  record(p: number, y: 0 | 1, edge: number): void {
    const base = this.n > 0 ? this.greens / this.n : 0.5;
    this.brier += (p - y) ** 2;
    this.brierBase += (base - y) ** 2;
    this.majorityHits += (base >= 0.5 ? 1 : 0) === y ? 1 : 0;
    this.n += 1;
    this.greens += y;
    if (Math.abs(p - 0.5) >= edge) {
      this.calls += 1;
      if ((p > 0.5 ? 1 : 0) === y) this.hits += 1;
    }
  }

  summary(): TrackSummary {
    return {
      n: this.n,
      calls: this.calls,
      hitRate: this.calls ? this.hits / this.calls : null,
      majority: this.n ? this.majorityHits / this.n : null,
      skill: this.n && this.brierBase > 0 ? 1 - this.brier / this.brierBase : null,
    };
  }
}

// ── Ghost candle: size from volatility, color from the call ──────────

export interface Ghost {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  dir: -1 | 0 | 1;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export class ShapeModel {
  private eRange: number | null = null;
  private eBody: number | null = null;
  private ups: number[] = [];
  private downs: number[] = [];
  private checks = 0;
  private inside = 0;
  private closeMiss = 0;
  private readonly alpha = 2 / 21;

  /** Feed every closed candle, after scoring any ghost made for it. */
  observe(c: Candle): void {
    const rng = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    if (this.eRange !== null && this.eRange > 0) {
      this.ups.push((c.high - c.open) / this.eRange);
      this.downs.push((c.open - c.low) / this.eRange);
      if (this.ups.length > 300) {
        this.ups.shift();
        this.downs.shift();
      }
    }
    this.eRange = this.eRange === null ? rng : this.eRange + this.alpha * (rng - this.eRange);
    this.eBody = this.eBody === null ? body : this.eBody + this.alpha * (body - this.eBody);
  }

  ghost(time: number, open: number, dir: -1 | 0 | 1): Ghost | null {
    if (this.eRange === null || this.eBody === null || this.ups.length < 50) return null;
    const close = open + dir * this.eBody;
    // 80% of candles stay inside these, judging by the last 300.
    const high = Math.max(open + quantile(this.ups, 0.8) * this.eRange, open, close);
    const low = Math.min(open - quantile(this.downs, 0.8) * this.eRange, open, close);
    return { time, open, high, low, close, dir };
  }

  score(g: Ghost, c: Candle): void {
    this.checks += 1;
    if (c.high <= g.high && c.low >= g.low) this.inside += 1;
    if (this.eRange && this.eRange > 0) this.closeMiss += Math.abs(c.close - g.close) / this.eRange;
  }

  summary() {
    return {
      n: this.checks,
      insideRate: this.checks ? this.inside / this.checks : null,
      avgCloseMiss: this.checks ? this.closeMiss / this.checks : null, // in typical-candle ranges
    };
  }
}

// ── Live (intra-candle) probability ─────────────────────────────────

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
/** Inverse normal CDF, close enough for turning a probability into an expected drift. */
const normInv = (p: number) => logit(p) / 1.702;

export interface Nowcast {
  pGreen: number; //     chance the forming candle closes green, given everything so far
  pPath: number; //      same, from the price action alone (no opinions): is the candle already decided?
  call: -1 | 0 | 1; //   live lean (uses the same edge as the open call)
  move: number; //       close − open so far
  timeLeftFrac: number;
  ghost: Ghost; //       re-projected candle
  /** Measured share of the move so far that historically survives to the close (null = not measured yet). */
  hold: number | null;
  /** Typical distance the close can still land from the expectation, in ATR units. */
  typicalLeft: number;
}

// ── Engine: one call per closed candle ───────────────────────────────

export interface Driver {
  name: string;
  push: number; // + toward green, − toward red (log-odds)
}

export interface Prediction {
  forTime: number; //  the candle this prediction is about
  pModel: number | null;
  pJev: number | null;
  jevConfidence: number | null;
  pFinal: number | null;
  call: -1 | 0 | 1;
  ghost: Ghost | null;
  drivers: Driver[];
}

export interface Outcome {
  call: -1 | 0 | 1;
  pFinal: number | null;
  hit: boolean | null; // null when no call or a doji
}

interface Pending {
  x: number[] | null;
  pModel: number | null;
  pJev: number | null;
  pFinal: number | null;
  call: -1 | 0 | 1;
  ghost: Ghost | null;
  counted: boolean; // made after warmup, so it goes in the scoreboard
  halfway: number | null; // live probability captured at the candle's halfway point
  jevLive: number | null; //  Jev's latest read on the forming candle
  liveContext: Record<string, unknown> | null; // built once per candle for live Jev calls
}

export class Engine {
  readonly features = new FeatureBuilder();
  readonly model = new OnlineLogit(N_FEATURES);
  readonly stacker = new Stacker();
  readonly shape = new ShapeModel();
  readonly track = { model: new Tracker(), jev: new Tracker(), final: new Tracker(), halfway: new Tracker() };
  private pending: Pending | null = null;
  /** Intra-candle mean reversion measured from 1-minute history (see reversion.ts). */
  reversion: ReversionFit | null = null;
  private recent: Candle[] = [];

  constructor(
    readonly tfSeconds: number,
    readonly edge = 0.56, //       min |p − 0.5| … expressed as p ≥ edge or p ≤ 1 − edge
    readonly warmup = 300, //      model updates before predictions count
  ) {}

  get warm(): boolean {
    return this.model.updates >= this.warmup;
  }

  private callFor(p: number | null): -1 | 0 | 1 {
    if (p === null || !this.warm) return 0;
    return p >= this.edge ? 1 : p <= 1 - this.edge ? -1 : 0;
  }

  /** Score the previous prediction against `c`, learn from it, and predict the next candle. */
  close(c: Candle): { outcome: Outcome | null; next: Prediction } {
    const edgeGap = this.edge - 0.5;
    let outcome: Outcome | null = null;
    const p = this.pending;
    if (p) {
      const y: 0 | 1 | null = c.close > c.open ? 1 : c.close < c.open ? 0 : null;
      if (p.ghost) this.shape.score(p.ghost, c);
      if (y !== null) {
        if (p.counted && p.pModel !== null) this.track.model.record(p.pModel, y, edgeGap);
        if (p.counted && p.pJev !== null) this.track.jev.record(p.pJev, y, edgeGap);
        if (p.counted && p.pFinal !== null) this.track.final.record(p.pFinal, y, edgeGap);
        if (p.counted && p.halfway !== null) this.track.halfway.record(p.halfway, y, edgeGap);
        if (p.pModel !== null && p.pJev !== null) this.stacker.update(p.pModel, p.pJev, y);
        if (p.x) this.model.update(p.x, y);
      } else if (p.x) {
        this.model.observe(p.x);
      }
      outcome = {
        call: p.call,
        pFinal: p.pFinal,
        hit: p.call === 0 || y === null ? null : (p.call === 1) === (y === 1),
      };
    }
    this.shape.observe(c);
    this.recent.push(c);
    if (this.recent.length > 200) this.recent.shift(); // ~2 days of 15m candles for Jev's context

    const x = this.features.push(c);
    const pModel = x ? this.model.predict(x) : null;
    const call = this.callFor(pModel);
    this.pending = {
      x,
      pModel,
      pJev: null,
      pFinal: pModel,
      call,
      ghost: this.shape.ghost(c.time + this.tfSeconds, c.close, call),
      counted: this.warm && pModel !== null,
      halfway: null,
      jevLive: null,
      liveContext: null,
    };
    return { outcome, next: this.view(c.time + this.tfSeconds) };
  }

  /** Typical spread of candle bodies (close − open) over the recent past. */
  private bodySd(): number | null {
    const rc = this.recent.slice(-100);
    if (rc.length < 30) return null;
    const b = rc.map((c) => c.close - c.open);
    const m = b.reduce((a, v) => a + v, 0) / b.length;
    const v = b.reduce((a, x) => a + (x - m) ** 2, 0) / (b.length - 1);
    return v > 0 ? Math.sqrt(v) : null;
  }

  /**
   * Live chance the forming candle closes green, re-computed on every tick.
   * Starts at the open call, then follows the candle: the move so far versus how much
   * the price can still travel in the time left (random-walk scaling of recent volatility).
   */
  nowcast(f: Candle, nowSec: number): Nowcast | null {
    const p = this.pending;
    if (!p || !p.ghost || f.time !== p.ghost.time) return null;
    const sd = this.bodySd();
    const atr = this.features.atr;
    if (!sd || !atr) return null;
    const frac = Math.min(1, Math.max(0.01, (f.time + this.tfSeconds - nowSec) / this.tfSeconds));
    // Lean for the rest of the candle: the open call, blended with Jev's latest live read if there is one.
    const prior = p.jevLive === null ? (p.pFinal ?? 0.5) : sigmoid(0.5 * logit(p.pFinal ?? 0.5) + 0.5 * logit(p.jevLive));
    const move = f.close - f.open;

    let expected: number; //  expected final body, ATR units
    let spread: number; //    uncertainty around it, ATR units
    let pathOnly: number; //  expected body from price action alone
    let hold: number | null = null;
    const fit = this.reversion;
    if (fit) {
      // Measured from 1-minute history: how much of a move at this point in the candle tends to survive.
      const minutesIn = (1 - frac) * fit.minutesPerCandle;
      const r = reversionAt(fit, minutesIn);
      hold = r.hold;
      spread = Math.max(r.spread, 0.02);
      const s0 = Math.max(fit.spread[0], 0.02);
      pathOnly = r.hold * (move / atr);
      expected = pathOnly + normInv(prior) * spread * (spread / s0);
    } else {
      // No history measured yet: assume a fair random walk for the rest of the candle.
      spread = (sd / atr) * Math.sqrt(frac);
      pathOnly = move / atr;
      expected = pathOnly + (sd / atr) * normInv(prior) * frac;
    }
    const pGreen = normCdf(expected / spread);
    const pPath = normCdf(pathOnly / spread);
    if (frac <= 0.5 && p.halfway === null) p.halfway = pGreen;

    const close = f.open + expected * atr;
    const reach = 1.28 * spread * atr; // 80% band around the expected close
    const call = this.callFor(pGreen);
    return {
      pGreen,
      pPath,
      call,
      move,
      timeLeftFrac: frac,
      hold,
      typicalLeft: spread,
      ghost: {
        time: f.time,
        open: f.open,
        close,
        high: Math.max(f.high, close, close + reach),
        low: Math.min(f.low, close, close - reach),
        dir: call,
      },
    };
  }

  /**
   * Small snapshot of the forming candle for a live Jev call: only fresh data, plus a short
   * context line that is built once per candle. `since` is the price at the previous live call.
   */
  describeLive(f: Candle, nowSec: number, since: { price: number; high: number; low: number } | null): Record<string, unknown> | null {
    const p = this.pending;
    const atr = this.features.atr;
    if (!p || !p.ghost || f.time !== p.ghost.time || !atr) return null;
    const r = (v: number) => Number(v.toFixed(2));
    if (!p.liveContext) {
      const rc = this.recent;
      const last3 = rc.slice(-3).map((c) => r((c.close - c.open) / atr));
      const day = rc.filter((c) => c.time > f.time - 86400);
      const hi = Math.max(...day.map((c) => c.high));
      const lo = Math.min(...day.map((c) => c.low));
      p.liveContext = {
        last_3_candle_bodies_atr: last3,
        high_24h_atr: r((hi - f.open) / atr),
        low_24h_atr: r((lo - f.open) / atr),
        round_10_above_atr: r((Math.ceil(f.open / 10) * 10 - f.open) / atr),
        round_10_below_atr: r((Math.floor(f.open / 10) * 10 - f.open) / atr),
      };
    }
    const left = Math.max(0, Math.round(f.time + this.tfSeconds - nowSec));
    const rng = f.high - f.low;
    const move = (f.close - f.open) / atr;
    const nc = this.nowcast(f, nowSec);
    return {
      units: "ATR units, measured from this candle's open unless stated.",
      forming_candle: {
        seconds_left: left,
        move_so_far: r(move),
        high_so_far: r((f.high - f.open) / atr),
        low_so_far: r((f.low - f.open) / atr),
        pulled_back_from_high: r((f.high - f.close) / atr),
        bounced_off_low: r((f.close - f.low) / atr),
        close_position_in_range: rng > 0 ? r((f.close - f.low) / rng) : 0.5,
      },
      reversion: nc
        ? {
            // From real gold 1-minute history: of a move this far into a candle, the share that is still there at the close.
            historically_holds_pct: nc.hold === null ? "not measured yet" : Math.round(nc.hold * 100),
            typical_move_left: r(nc.typicalLeft),
            move_vs_typical_move_left: r(move / Math.max(nc.typicalLeft, 0.01)),
          }
        : "not available",
      last_10_seconds: since
        ? { move: r((f.close - since.price) / atr), made_new_high: f.high > since.high, made_new_low: f.low < since.low }
        : "first look at this candle",
      context: p.liveContext,
    };
  }

  /** Fold Jev's live read of the forming candle into the live probability. */
  applyJevLive(f: Candle, pGreen: number): void {
    const p = this.pending;
    if (p && p.ghost && f.time === p.ghost.time) p.jevLive = pGreen;
  }

  /** Fold Jev's answer into the pending prediction. pGreen is Jev's probability the next candle is green. */
  applyJev(pGreen: number, confidence: number): Prediction | null {
    const p = this.pending;
    if (!p || p.pModel === null || !p.ghost) return null;
    // Use Jev's real probability; the stacker learns how much it deserves from its track record.
    p.pJev = pGreen;
    p.pFinal = this.stacker.predict(p.pModel, p.pJev);
    p.call = this.callFor(p.pFinal);
    p.ghost = this.shape.ghost(p.ghost.time, p.ghost.open, p.call);
    return this.view(p.ghost?.time ?? 0, confidence);
  }

  private view(forTime: number, jevConfidence: number | null = null): Prediction {
    const p = this.pending!;
    let drivers: Driver[] = [];
    if (p.x && this.warm) {
      drivers = this.model
        .contributions(p.x)
        .map((push, i) => ({ name: FEATURES[i]!, push }))
        .sort((a, b) => Math.abs(b.push) - Math.abs(a.push))
        .slice(0, 3);
    }
    return {
      forTime,
      pModel: p.pModel,
      pJev: p.pJev,
      jevConfidence,
      pFinal: p.pFinal,
      call: p.call,
      ghost: p.ghost,
      drivers,
    };
  }

  /**
   * Market picture for Jev: recent candles, higher-timeframe candles, key levels, session and
   * the model's engineered signals. Sizes are in ATR units so Jev reads structure, not raw prices.
   */
  describeForJev(): Record<string, unknown> | null {
    const x = this.pending?.x;
    const atr = this.features.atr;
    const rc = this.recent;
    if (!x || !atr || rc.length < 20) return null;
    const r = (v: number) => Number(v.toFixed(2));
    const last = rc[rc.length - 1];
    const px = last.close;

    const describe = (c: Candle) => ({
      c: c.close > c.open ? "G" : c.close < c.open ? "R" : "D",
      body: r((c.close - c.open) / atr),
      range: r((c.high - c.low) / atr),
      close_at: c.high > c.low ? r((c.close - c.low) / (c.high - c.low)) : 0.5,
      up_wick: r((c.high - Math.max(c.open, c.close)) / atr),
      dn_wick: r((Math.min(c.open, c.close) - c.low) / atr),
    });

    // Roll candles up into a bigger timeframe, aligned to the clock.
    const rollup = (secs: number, n: number) => {
      const out: Candle[] = [];
      for (const c of rc) {
        const b = Math.floor(c.time / secs) * secs;
        const cur = out[out.length - 1];
        if (cur && cur.time === b) {
          cur.high = Math.max(cur.high, c.high);
          cur.low = Math.min(cur.low, c.low);
          cur.close = c.close;
        } else out.push({ time: b, open: c.open, high: c.high, low: c.low, close: c.close });
      }
      return out.slice(-n).map(describe);
    };

    const day = rc.filter((c) => c.time > last.time - 86400);
    const hi24 = Math.max(...day.map((c) => c.high));
    const lo24 = Math.min(...day.map((c) => c.low));
    const lastRange = last.high - last.low;
    const rangePct = day.filter((c) => c.high - c.low <= lastRange).length / day.length;

    // Gold's trading day rolls over at 22:00 UTC.
    const dayStart = Math.floor((last.time - 22 * 3600) / 86400) * 86400 + 22 * 3600;
    const today = rc.filter((c) => c.time >= dayStart);
    const prevDay = rc.filter((c) => c.time >= dayStart - 86400 && c.time < dayStart);
    const lvl = (v: number) => r((v - px) / atr);
    const hiOf = (cs: Candle[]) => (cs.length ? lvl(Math.max(...cs.map((c) => c.high))) : null);
    const loOf = (cs: Candle[]) => (cs.length ? lvl(Math.min(...cs.map((c) => c.low))) : null);

    const hourUtc = new Date((last.time + this.tfSeconds) * 1000).getUTCHours();
    const session =
      hourUtc >= 13 && hourUtc < 16 ? "London/New York overlap"
      : hourUtc >= 7 && hourUtc < 13 ? "London"
      : hourUtc >= 16 && hourUtc < 21 ? "New York"
      : "Asia / quiet hours";

    const round = (step: number) => {
      const below = Math.floor(px / step) * step;
      return { below: lvl(below), above: lvl(below + step) };
    };

    return {
      focus:
        "Only the NEXT single 15-minute candle matters. Weigh the last 1-3 candles most: their size, wicks, " +
        "where they closed, and whether price just hit a nearby level. Longer-term trend is background only.",
      how_to_read:
        "c = color (G/R/D). body (signed), range and wicks are in ATR units. close_at: 0 = closed at the low, 1 = at the high. " +
        "Levels are signed distance from current price in ATR units (positive = above price). Candle lists are oldest first.",
      atr_dollars: r(atr),
      session_of_next_candle: session,
      candles_15m_last_16: rc.slice(-16).map(describe),
      candles_1h_last_6: rollup(3600, 6),
      levels: {
        high_24h: lvl(hi24),
        low_24h: lvl(lo24),
        position_in_24h_range: hi24 > lo24 ? r((px - lo24) / (hi24 - lo24)) : 0.5,
        today_open: today.length ? lvl(today[0].open) : null,
        today_high: hiOf(today),
        today_low: loOf(today),
        prev_day_high: hiOf(prevDay),
        prev_day_low: loOf(prevDay),
        round_10_dollars: round(10),
        round_50_dollars: round(50),
      },
      last_candle_size_percentile_24h: r(rangePct),
      signals: Object.fromEntries(FEATURES.slice(0, 13).map((name, i) => [name, r(x[i]!)])),
    };
  }

  summary() {
    return {
      warm: this.warm,
      learnedFrom: this.model.updates,
      warmup: this.warmup,
      model: this.track.model.summary(),
      jev: this.track.jev.summary(),
      final: this.track.final.summary(),
      halfway: this.track.halfway.summary(),
      shape: this.shape.summary(),
      jevWeight: this.stacker.updates ? this.stacker.wJev / Math.max(0.1, Math.abs(this.stacker.wModel)) : null,
    };
  }
}
