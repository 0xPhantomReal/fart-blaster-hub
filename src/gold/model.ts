// Quant engine: scale-free features → online logistic regression → (optional) Jev blend.
// Strict walk-forward: every prediction is made before the model sees that candle's outcome.

import { Ema, Rma, type Candle } from "./indicators";

// ── Features ──────────────────────────────────────────────────────────

export const FEATURES = [
  "Last candle body", //            signed body ÷ prior ATR
  "Big candle × direction", //      (range ÷ prior ATR − 1) × sign(body): your big-candle fade
  "Close position in candle", //    0 = at low, 1 = at high (centred)
  "Wick pressure", //               (lower wick − upper wick) ÷ range
  "3-candle move", //               ATR units
  "12-candle move", //              ATR·√12 units
  "Distance from fast EMA", //      ATR units
  "Trend (EMA 9 vs 21)", //         ATR units
  "RSI", //                         centred, −1…1
  "Streak", //                      −1…1
  "Room to 20-candle high", //      ATR units (ceiling)
  "Room to 20-candle low", //       ATR units (floor)
  "Volatility regime", //           ATR vs its 100-candle average
  "Time of day",
  "Time of day",
] as const;
export const N_FEATURES = FEATURES.length;

const clip = (x: number, a = 4) => Math.max(-a, Math.min(a, x));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return Math.log(q / (1 - q));
};

export class FeatureBuilder {
  private emaF = new Ema(9);
  private emaS = new Ema(21);
  private up = new Rma(14);
  private dn = new Rma(14);
  private atrR = new Rma(14);
  private atrSlow = new Ema(100);
  private closes: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private streak = 0;
  private prevAtr: number | null = null;
  atr: number | null = null;

  /** Features describing the market once candle `c` has closed, or null while warming up. */
  push(c: Candle): number[] | null {
    const prevClose = this.closes.length ? this.closes[this.closes.length - 1] : undefined;
    const tr =
      prevClose === undefined
        ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    let rsi: number | null = null;
    if (prevClose !== undefined) {
      const ch = c.close - prevClose;
      const u = this.up.update(Math.max(ch, 0));
      const d = this.dn.update(Math.max(-ch, 0));
      if (u !== null && d !== null) rsi = d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
    }
    const atrPrev = this.prevAtr;
    const atr = this.atrR.update(tr);
    this.prevAtr = atr;
    this.atr = atr;
    const atrSlow = atr === null ? null : this.atrSlow.update(atr);
    const ef = this.emaF.update(c.close);
    const es = this.emaS.update(c.close);

    this.closes.push(c.close);
    this.highs.push(c.high);
    this.lows.push(c.low);
    if (this.closes.length > 30) {
      this.closes.shift();
      this.highs.shift();
      this.lows.shift();
    }
    const body = c.close - c.open;
    const rng = c.high - c.low;
    this.streak = body > 0 ? (this.streak > 0 ? this.streak + 1 : 1) : body < 0 ? (this.streak < 0 ? this.streak - 1 : -1) : 0;

    if (
      atr === null || atrPrev === null || atrSlow === null || ef === null || es === null || rsi === null ||
      this.closes.length < 21 || atr <= 0 || atrPrev <= 0 || atrSlow <= 0
    ) {
      return null;
    }

    const n = this.closes.length;
    const c3 = this.closes[n - 4]!;
    const c12 = this.closes[n - 13]!;
    const hi20 = Math.max(...this.highs.slice(-20));
    const lo20 = Math.min(...this.lows.slice(-20));
    const upW = c.high - Math.max(c.open, c.close);
    const loW = Math.min(c.open, c.close) - c.low;
    const d = new Date((c.time + 0) * 1000);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;

    return [
      clip(body / atrPrev),
      clip((rng / atrPrev - 1) * Math.sign(body)),
      rng > 0 ? (c.close - c.low) / rng - 0.5 : 0,
      rng > 0 ? (loW - upW) / rng : 0,
      clip((c.close - c3) / atr),
      clip((c.close - c12) / (atr * Math.sqrt(12))),
      clip((c.close - ef) / atr),
      clip((ef - es) / atr),
      (rsi - 50) / 50,
      clip(this.streak, 6) / 6,
      clip((hi20 - c.close) / atr),
      clip((c.close - lo20) / atr),
      clip(atr / atrSlow - 1),
      Math.sin((2 * Math.PI * hour) / 24),
      Math.cos((2 * Math.PI * hour) / 24),
    ];
  }
}

// ── Online logistic regression (AdaGrad, standardized inputs, L2) ────

export class OnlineLogit {
  readonly w: number[];
  private b = 0;
  private G: number[];
  private Gb = 1e-8;
  private mean: number[];
  private m2: number[];
  private seen = 0;
  updates = 0;

  constructor(private dim: number, private lr = 0.05, private l2 = 1e-3) {
    this.w = new Array(dim).fill(0);
    this.G = new Array(dim).fill(1e-8);
    this.mean = new Array(dim).fill(0);
    this.m2 = new Array(dim).fill(0);
  }

  private z(x: number[]): number[] {
    if (this.seen < 2) return x.map(() => 0);
    return x.map((v, i) => clip((v - this.mean[i]!) / Math.sqrt(this.m2[i]! / (this.seen - 1) + 1e-9), 5));
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
    for (let i = 0; i < this.dim; i++) {
      const gi = g * z[i]! + this.l2 * this.w[i]!;
      this.G[i]! += gi * gi;
      this.w[i]! -= (this.lr * gi) / Math.sqrt(this.G[i]!);
    }
    this.Gb += g * g;
    this.b -= (this.lr * g) / Math.sqrt(this.Gb);
    this.observe(x);
    this.updates += 1;
  }

  /** Update the scaler only (used for doji candles, which teach no direction). */
  observe(x: number[]): void {
    this.seen += 1;
    for (let i = 0; i < this.dim; i++) {
      const delta = x[i]! - this.mean[i]!;
      this.mean[i]! += delta / this.seen;
      this.m2[i]! += delta * (x[i]! - this.mean[i]!);
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
}

export class Engine {
  readonly features = new FeatureBuilder();
  readonly model = new OnlineLogit(N_FEATURES);
  readonly stacker = new Stacker();
  readonly shape = new ShapeModel();
  readonly track = { model: new Tracker(), jev: new Tracker(), final: new Tracker() };
  private pending: Pending | null = null;
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
    };
    return { outcome, next: this.view(c.time + this.tfSeconds) };
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
      how_to_read:
        "c = color (G/R/D). body (signed), range and wicks are in ATR units. close_at: 0 = closed at the low, 1 = at the high. " +
        "Levels are signed distance from current price in ATR units (positive = above price). Candle lists are oldest first.",
      atr_dollars: r(atr),
      session_of_next_candle: session,
      candles_15m_last_16: rc.slice(-16).map(describe),
      candles_1h_last_12: rollup(3600, 12),
      candles_4h_last_6: rollup(4 * 3600, 6),
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
      shape: this.shape.summary(),
      jevWeight: this.stacker.updates ? this.stacker.wJev / Math.max(0.1, Math.abs(this.stacker.wModel)) : null,
    };
  }
}
