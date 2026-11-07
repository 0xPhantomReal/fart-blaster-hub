// Lightspeed V0.5 — the candle-math block Jev sees on every call (see docs/lightspeed-v0.5-research.md).
// Pure functions of the chart's candles, so the website and the Polymarket bot compute exactly the same thing.
// AUTO-COPIED from src/gold/lightspeedCore.ts — keep in step (src/gold/lightspeedCore.test.ts checks parity).

export interface LsCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const r = (x: number, d = 2) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

function std(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Per-candle volatility of log returns: close-to-close, Parkinson (high-low) and EWMA (λ = 0.94). */
export function candleVol(closed: LsCandle[]) {
  const rets = closed.slice(1).map((c, i) => Math.log(c.close / closed[i].close));
  const last48 = rets.slice(-48);
  const cc = std(last48);
  const pk = closed.slice(-48).map((c) => Math.log(c.high / c.low) ** 2);
  const parkinson = pk.length ? Math.sqrt(pk.reduce((s, x) => s + x, 0) / (4 * Math.LN2 * pk.length)) : NaN;
  let ewma = NaN;
  for (const x of rets.slice(-200)) ewma = Number.isNaN(ewma) ? x * x : 0.94 * ewma + 0.06 * x * x;
  const long = std(rets.slice(-288));
  // the blend used for the finish probability: average of the three estimates that exist
  const parts = [cc, parkinson, Math.sqrt(ewma)].filter((x) => Number.isFinite(x) && x > 0);
  const blend = parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : NaN;
  return { cc, parkinson, ewma: Math.sqrt(ewma), long, blend, regime: Number.isFinite(long) && long > 0 ? cc / long : NaN };
}

/** Lag-1 autocorrelation and color persistence over the last `n` candles. */
function serial(closed: LsCandle[], n = 288) {
  const c = closed.slice(-(n + 1));
  const rets = c.slice(1).map((x, i) => x.close - c[i].close);
  const body = c.map((x) => Math.sign(x.close - x.open));
  let ac = NaN;
  if (rets.length > 20) {
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < rets.length; i++) {
      den += (rets[i] - m) ** 2;
      if (i > 0) num += (rets[i] - m) * (rets[i - 1] - m);
    }
    ac = den > 0 ? num / den : NaN;
  }
  let gg = 0;
  let g = 0;
  let rg = 0;
  let rr = 0;
  for (let i = 1; i < body.length; i++) {
    if (body[i - 1] > 0) {
      g += 1;
      if (body[i] > 0) gg += 1;
    } else if (body[i - 1] < 0) {
      rr += 1;
      if (body[i] > 0) rg += 1;
    }
  }
  return { ac, pGreenAfterGreen: g ? gg / g : NaN, pGreenAfterRed: rr ? rg / rr : NaN, n: body.length };
}

/** The clock: sessions, funding times, the turn of 15-minute candles. */
export function clock(t: number) {
  const d = new Date(t * 1000);
  const utcH = d.getUTCHours() + d.getUTCMinutes() / 60;
  const dow = d.getUTCDay();
  // US Eastern offset (DST: 2nd Sunday of March 2:00 → 1st Sunday of November 2:00)
  const y = d.getUTCFullYear();
  const nthSunday = (month: number, nth: number) => {
    const first = new Date(Date.UTC(y, month, 1));
    return 1 + ((7 - first.getUTCDay()) % 7) + 7 * (nth - 1);
  };
  const dstStart = Date.UTC(y, 2, nthSunday(2, 2), 7);
  const dstEnd = Date.UTC(y, 10, nthSunday(10, 1), 6);
  const etOffset = t * 1000 >= dstStart && t * 1000 < dstEnd ? -4 : -5;
  const et = new Date(t * 1000 + etOffset * 3600_000);
  const etH = et.getUTCHours() + et.getUTCMinutes() / 60;
  const etDow = et.getUTCDay();
  const usOpen = etDow >= 1 && etDow <= 5 && etH >= 9.5 && etH < 16;
  const nextFunding = [0, 8, 16, 24].find((h) => h > utcH) ?? 24;
  return {
    utc: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    us_eastern: `${String(et.getUTCHours()).padStart(2, "0")}:${String(et.getUTCMinutes()).padStart(2, "0")}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow],
    weekend: dow === 0 || dow === 6,
    us_stock_market_open: usOpen,
    minutes_since_us_open: usOpen ? Math.round((etH - 9.5) * 60) : null,
    minutes_to_next_funding_time: Math.round((nextFunding - utcH) * 60),
    turn_of_15m_candle: t % 900 === 0,
    session: utcH < 7 ? "Asia" : utcH < 13.5 ? "Europe" : utcH < 21 ? "US" : "late US / pre-Asia",
  };
}

/** Distance to round numbers and recent extremes, in dollars and ATR. */
function levels(price: number, closed: LsCandle[], tfSec: number, atr: number) {
  const day = closed.filter((c) => c.time >= closed[closed.length - 1].time - 86400 + tfSec);
  const hi = Math.max(...day.map((c) => c.high));
  const lo = Math.min(...day.map((c) => c.low));
  const round = (step: number) => {
    const below = Math.floor(price / step) * step;
    const above = below + step;
    const near = price - below < above - price ? below : above;
    return { level: near, dollars: r(price - near), atr: r((price - near) / atr) };
  };
  const last = closed[closed.length - 1];
  return {
    nearest_100: round(100),
    nearest_500: round(500),
    nearest_1000: round(1000),
    day_high_above_atr: r((hi - price) / atr),
    day_low_below_atr: r((price - lo) / atr),
    position_in_day_range: hi > lo ? r((price - lo) / (hi - lo)) : null,
    last_candle_high_above_atr: r((last.high - price) / atr),
    last_candle_low_below_atr: r((price - last.low) / atr),
  };
}

/**
 * The Lightspeed candle-math block for the candle opening at `forTime`.
 * `forming` = the candle so far (null when the call is made at the open); `elapsed` = seconds into the candle.
 */
export function lightspeedCore(
  closedAll: LsCandle[],
  forTime: number,
  tfSec: number,
  elapsed: number,
  forming: LsCandle | null,
): Record<string, unknown> | null {
  let end = closedAll.length;
  while (end > 0 && closedAll[end - 1].time + tfSec > forTime) end -= 1;
  const closed = closedAll.slice(Math.max(0, end - 600), end);
  if (closed.length < 60) return null;
  const last = closed[closed.length - 1];
  const tr = closed.slice(-14).map((c, i, a) =>
    i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - a[i - 1].close), Math.abs(c.low - a[i - 1].close)),
  );
  const atr = tr.reduce((s, x) => s + x, 0) / tr.length;
  const vol = candleVol(closed);
  const ser = serial(closed);
  const price = forming ? forming.close : last.close;
  const sigmaCandle = vol.blend; // per-candle log-return σ

  // The math baseline: chance the candle finishes green from where it is, with the time left and volatility.
  let finish: Record<string, unknown> | null = null;
  if (forming && sigmaCandle > 0) {
    const left = Math.max(1, tfSec - elapsed);
    const sigmaLeft = sigmaCandle * Math.sqrt(left / tfSec);
    const z = Math.log(forming.close / forming.open) / sigmaLeft;
    finish = {
      seconds_left: Math.round(left),
      move_dollars: r(forming.close - forming.open),
      move_in_atr: r((forming.close - forming.open) / atr),
      z_score: r(z),
      random_walk_p_green_pct: r(normCdf(z) * 100, 1),
      typical_move_in_time_left_dollars: r(price * sigmaLeft),
      note: "random-walk chance it finishes above its open (N(d2) of a binary option); the baseline to adjust",
    };
  }

  const ret = (k: number) => {
    const c0 = closed[closed.length - 1 - k];
    return c0 ? r((price - c0.close) / atr) : null;
  };
  let streak = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const s = Math.sign(closed[i].close - closed[i].open);
    if (s === 0 || (streak !== 0 && Math.sign(streak) !== s)) break;
    streak += s;
  }
  const greenShare = (k: number) => {
    const c = closed.slice(-k);
    return r((c.filter((x) => x.close > x.open).length / c.length) * 100, 1);
  };
  const shape = forming
    ? (() => {
        const rng = forming.high - forming.low;
        return {
          range_in_atr: r(rng / atr),
          close_location_in_range: rng > 0 ? r((forming.close - forming.low) / rng) : null,
          upper_wick_in_atr: r((forming.high - Math.max(forming.open, forming.close)) / atr),
          lower_wick_in_atr: r((Math.min(forming.open, forming.close) - forming.low) / atr),
        };
      })()
    : null;

  return {
    version: "Lightspeed V0.5",
    seconds_into_candle: Math.round(elapsed),
    ...(finish ? { finish_probability: finish } : {}),
    volatility: {
      per_candle_pct: r(sigmaCandle * 100, 3),
      atr_dollars: r(atr),
      close_to_close_pct: r(vol.cc * 100, 3),
      high_low_parkinson_pct: r(vol.parkinson * 100, 3),
      ewma_pct: r(vol.ewma * 100, 3),
      regime_vs_last_day: r(vol.regime),
    },
    serial_dependence: {
      lag1_autocorrelation: r(ser.ac, 3),
      p_green_after_green_pct: r(ser.pGreenAfterGreen * 100, 1),
      p_green_after_red_pct: r(ser.pGreenAfterRed * 100, 1),
      candles_counted: ser.n,
      note: "negative autocorrelation = moves tend to reverse candle to candle",
    },
    base_rates: {
      green_pct_last_12: greenShare(12),
      green_pct_last_48: greenShare(48),
      green_pct_last_288: greenShare(Math.min(288, closed.length)),
      streak: streak > 0 ? `${streak} green` : streak < 0 ? `${-streak} red` : "none",
    },
    momentum_in_atr: { last_3: ret(3), last_12: ret(12), last_48: ret(48) },
    ...(shape ? { candle_shape_so_far: shape } : {}),
    levels: levels(price, closed, tfSec, atr),
    clock: clock(forTime + elapsed),
  };
}
