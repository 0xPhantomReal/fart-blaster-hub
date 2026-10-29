// Candlestick and chart pattern recognition, plus measuring what each pattern has actually been worth on gold.
//
// Everything is in ATR units so the rules mean the same thing in calm and busy markets. Chart patterns are
// built from swing highs/lows ("pivots") that are only used once they are confirmed, so nothing here peeks
// at candles that hadn't happened yet.

import type { Candle } from "./indicators";

export type Bias = "bull" | "bear" | "neutral";

export interface CandlePattern {
  name: string;
  bias: Bias;
}

export interface Line {
  from: { time: number; price: number };
  to: { time: number; price: number };
}

export interface ChartPattern {
  name: string;
  bias: Bias;
  status: "forming" | "confirmed"; // confirmed = neckline/level/trendline broken on the latest candle
  lines: Line[]; //                   what to draw
  key: string; //                     stable id for measuring ("Double top · confirmed")
}

// ── Helpers ───────────────────────────────────────────────────────────

export function wilderAtr(cs: Candle[], len = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let atr: number | null = null;
  const seed: number[] = [];
  cs.forEach((c, i) => {
    const pc = i ? cs[i - 1].close : null;
    const tr = pc === null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (atr === null) {
      seed.push(tr);
      if (seed.length === len) atr = seed.reduce((a, v) => a + v, 0) / len;
    } else atr = (tr + (len - 1) * atr) / len;
    out.push(atr);
  });
  return out;
}

const body = (c: Candle) => Math.abs(c.close - c.open);
const upper = (c: Candle) => c.high - Math.max(c.open, c.close);
const lower = (c: Candle) => Math.min(c.open, c.close) - c.low;
const green = (c: Candle) => c.close > c.open;
const red = (c: Candle) => c.close < c.open;

// ── Candlestick patterns (on the candle at index i) ─────────────────────

export function candlePatterns(cs: Candle[], i: number, atr: number): CandlePattern[] {
  if (i < 3 || atr <= 0) return [];
  const c = cs[i];
  const p = cs[i - 1];
  const p2 = cs[i - 2];
  const out: CandlePattern[] = [];
  const add = (name: string, bias: Bias) => out.push({ name, bias });
  const rng = c.high - c.low;
  const b = body(c);
  const priorMove = (c.close - cs[i - 3].close) / atr; // context: was price falling or rising into this?
  const fell = cs[i - 1].close - cs[i - 3].close < -0.5 * atr;
  const rose = cs[i - 1].close - cs[i - 3].close > 0.5 * atr;
  void priorMove;

  if (rng >= 0.3 * atr && b <= 0.1 * rng) add("Doji", "neutral");

  const smallBody = b > 0.05 * rng && b <= 0.35 * rng;
  if (smallBody && lower(c) >= 2 * b && upper(c) <= 0.15 * rng) {
    if (fell) add("Hammer", "bull");
    else if (rose) add("Hanging man", "bear");
  }
  if (smallBody && upper(c) >= 2 * b && lower(c) <= 0.15 * rng) {
    if (rose) add("Shooting star", "bear");
    else if (fell) add("Inverted hammer", "bull");
  }

  if (red(p) && green(c) && c.close >= p.open && c.open <= p.close && b > body(p) && b >= 0.3 * atr) add("Bullish engulfing", "bull");
  if (green(p) && red(c) && c.close <= p.open && c.open >= p.close && b > body(p) && b >= 0.3 * atr) add("Bearish engulfing", "bear");

  if (red(p) && body(p) >= 0.6 * atr && green(c) && c.close < p.open && c.open > p.close && b <= 0.5 * body(p)) add("Bullish harami", "bull");
  if (green(p) && body(p) >= 0.6 * atr && red(c) && c.close > p.open && c.open < p.close && b <= 0.5 * body(p)) add("Bearish harami", "bear");

  const pMid = (p.open + p.close) / 2;
  if (red(p) && body(p) >= 0.6 * atr && green(c) && c.open <= p.close + 0.05 * atr && c.close > pMid && c.close < p.open) add("Piercing line", "bull");
  if (green(p) && body(p) >= 0.6 * atr && red(c) && c.open >= p.close - 0.05 * atr && c.close < pMid && c.close > p.open) add("Dark cloud cover", "bear");

  const p2Mid = (p2.open + p2.close) / 2;
  if (red(p2) && body(p2) >= 0.6 * atr && body(p) <= 0.3 * atr && green(c) && b >= 0.5 * atr && c.close > p2Mid) add("Morning star", "bull");
  if (green(p2) && body(p2) >= 0.6 * atr && body(p) <= 0.3 * atr && red(c) && b >= 0.5 * atr && c.close < p2Mid) add("Evening star", "bear");

  const three = [p2, p, c];
  if (three.every((k) => green(k) && body(k) >= 0.5 * atr && upper(k) <= 0.3 * body(k)) && p.close > p2.close && c.close > p.close)
    add("Three white soldiers", "bull");
  if (three.every((k) => red(k) && body(k) >= 0.5 * atr && lower(k) <= 0.3 * body(k)) && p.close < p2.close && c.close < p.close)
    add("Three black crows", "bear");

  if (b >= 0.9 * rng && b >= 1.0 * atr) add(green(c) ? "Bullish marubozu" : "Bearish marubozu", green(c) ? "bull" : "bear");

  if (green(p) && red(c) && Math.abs(c.high - p.high) <= 0.05 * atr && rose) add("Tweezer top", "bear");
  if (red(p) && green(c) && Math.abs(c.low - p.low) <= 0.05 * atr && fell) add("Tweezer bottom", "bull");

  return out;
}

// ── Swing pivots (zigzag) ─────────────────────────────────────────────

export interface Pivot {
  i: number; //         candle index of the swing high/low
  price: number;
  type: "H" | "L";
  confirmedAt: number; // first candle index at which the swing was known (price had reversed by the threshold)
}

/** Swing highs/lows that reversed by at least `k` × ATR. */
export function pivots(cs: Candle[], atrs: (number | null)[], k = 1.5): Pivot[] {
  const out: Pivot[] = [];
  let dir: "up" | "down" | null = null;
  let extI = 0;
  for (let i = 1; i < cs.length; i++) {
    const a = atrs[i] ?? atrs.find((x) => x) ?? 1;
    const th = k * a!;
    if (dir === null) {
      if (cs[i].high - cs[extI].low > th) {
        out.push({ i: extI, price: cs[extI].low, type: "L", confirmedAt: i });
        dir = "up";
        extI = i;
      } else if (cs[extI].high - cs[i].low > th) {
        out.push({ i: extI, price: cs[extI].high, type: "H", confirmedAt: i });
        dir = "down";
        extI = i;
      } else if (cs[i].high > cs[extI].high || cs[i].low < cs[extI].low) extI = i;
      continue;
    }
    if (dir === "up") {
      if (cs[i].high >= cs[extI].high) extI = i;
      else if (cs[extI].high - cs[i].low > th) {
        out.push({ i: extI, price: cs[extI].high, type: "H", confirmedAt: i });
        dir = "down";
        extI = i;
      }
    } else {
      if (cs[i].low <= cs[extI].low) extI = i;
      else if (cs[i].high - cs[extI].low > th) {
        out.push({ i: extI, price: cs[extI].low, type: "L", confirmedAt: i });
        dir = "up";
        extI = i;
      }
    }
  }
  return out;
}

// ── Chart patterns at candle t (using only pivots confirmed by t) ───────

function fitLine(pts: { i: number; price: number }[]) {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.i, 0) / n;
  const my = pts.reduce((a, p) => a + p.price, 0) / n;
  const sxx = pts.reduce((a, p) => a + (p.i - mx) ** 2, 0);
  const slope = sxx > 0 ? pts.reduce((a, p) => a + (p.i - mx) * (p.price - my), 0) / sxx : 0;
  return { slope, at: (i: number) => my + slope * (i - mx) };
}

export function chartPatterns(cs: Candle[], t: number, atr: number, piv: Pivot[]): ChartPattern[] {
  if (atr <= 0) return [];
  const known = piv.filter((p) => p.confirmedAt <= t && p.i >= t - 150);
  const out: ChartPattern[] = [];
  const c = cs[t];
  const prev = cs[t - 1];
  const T = (i: number) => cs[Math.min(i, cs.length - 1)].time;
  const add = (name: string, bias: Bias, status: ChartPattern["status"], lines: Line[]) =>
    out.push({ name, bias, status, lines, key: `${name} · ${status}` });
  const last = (n: number) => known.slice(-n);

  // Double top / bottom: two similar swing extremes with a meaningful dip/rally between them.
  const [a, b2, c2] = last(3);
  if (a && b2 && c2) {
    if (a.type === "H" && b2.type === "L" && c2.type === "H" && Math.abs(a.price - c2.price) <= 0.4 * atr && Math.min(a.price, c2.price) - b2.price >= 1.5 * atr) {
      const broke = c.close < b2.price && prev.close >= b2.price;
      const stillValid = c.close >= b2.price - 0.5 * atr && c.high <= Math.max(a.price, c2.price) + 0.3 * atr;
      if (broke || stillValid)
        add("Double top", "bear", broke ? "confirmed" : "forming", [
          { from: { time: T(a.i), price: a.price }, to: { time: T(c2.i), price: c2.price } },
          { from: { time: T(b2.i), price: b2.price }, to: { time: T(t), price: b2.price } },
        ]);
    }
    if (a.type === "L" && b2.type === "H" && c2.type === "L" && Math.abs(a.price - c2.price) <= 0.4 * atr && b2.price - Math.max(a.price, c2.price) >= 1.5 * atr) {
      const broke = c.close > b2.price && prev.close <= b2.price;
      const stillValid = c.close <= b2.price + 0.5 * atr && c.low >= Math.min(a.price, c2.price) - 0.3 * atr;
      if (broke || stillValid)
        add("Double bottom", "bull", broke ? "confirmed" : "forming", [
          { from: { time: T(a.i), price: a.price }, to: { time: T(c2.i), price: c2.price } },
          { from: { time: T(b2.i), price: b2.price }, to: { time: T(t), price: b2.price } },
        ]);
    }
  }

  // Head and shoulders (and inverse): shoulder, neck, head, neck, shoulder.
  const hs = last(5);
  if (hs.length === 5) {
    const [s1, n1, h, n2, s2] = hs;
    const neck = (i: number) => n1.price + ((n2.price - n1.price) / (n2.i - n1.i || 1)) * (i - n1.i);
    if (s1.type === "H" && h.type === "H" && s2.type === "H" && h.price - Math.max(s1.price, s2.price) >= 0.5 * atr && Math.abs(s1.price - s2.price) <= 0.8 * atr) {
      const broke = c.close < neck(t) && prev.close >= neck(t - 1);
      if (broke || c.close >= neck(t) - 0.5 * atr)
        add("Head & shoulders", "bear", broke ? "confirmed" : "forming", [
          { from: { time: T(s1.i), price: s1.price }, to: { time: T(h.i), price: h.price } },
          { from: { time: T(h.i), price: h.price }, to: { time: T(s2.i), price: s2.price } },
          { from: { time: T(n1.i), price: n1.price }, to: { time: T(t), price: neck(t) } },
        ]);
    }
    if (s1.type === "L" && h.type === "L" && s2.type === "L" && Math.min(s1.price, s2.price) - h.price >= 0.5 * atr && Math.abs(s1.price - s2.price) <= 0.8 * atr) {
      const broke = c.close > neck(t) && prev.close <= neck(t - 1);
      if (broke || c.close <= neck(t) + 0.5 * atr)
        add("Inverse head & shoulders", "bull", broke ? "confirmed" : "forming", [
          { from: { time: T(s1.i), price: s1.price }, to: { time: T(h.i), price: h.price } },
          { from: { time: T(h.i), price: h.price }, to: { time: T(s2.i), price: s2.price } },
          { from: { time: T(n1.i), price: n1.price }, to: { time: T(t), price: neck(t) } },
        ]);
    }
  }

  // Triangles: trendlines through the last 3 swing highs and last 3 swing lows, converging.
  const highs = known.filter((p) => p.type === "H").slice(-3);
  const lows = known.filter((p) => p.type === "L").slice(-3);
  if (highs.length === 3 && lows.length === 3 && Math.min(highs[0].i, lows[0].i) >= t - 120) {
    const hl = fitLine(highs);
    const ll = fitLine(lows);
    const flat = 0.02 * atr; // per candle
    const gapNow = hl.at(t) - ll.at(t);
    const gapThen = hl.at(Math.min(highs[0].i, lows[0].i)) - ll.at(Math.min(highs[0].i, lows[0].i));
    if (gapNow > 0 && gapNow < gapThen * 0.85) {
      const kind =
        Math.abs(hl.slope) <= flat && ll.slope > flat
          ? { name: "Ascending triangle", bias: "bull" as Bias }
          : Math.abs(ll.slope) <= flat && hl.slope < -flat
            ? { name: "Descending triangle", bias: "bear" as Bias }
            : hl.slope < -flat && ll.slope > flat
              ? { name: "Symmetrical triangle", bias: "neutral" as Bias }
              : null;
      if (kind) {
        const upBreak = c.close > hl.at(t) + 0.2 * atr && prev.close <= hl.at(t - 1) + 0.2 * atr;
        const dnBreak = c.close < ll.at(t) - 0.2 * atr && prev.close >= ll.at(t - 1) - 0.2 * atr;
        const lines = [
          { from: { time: T(highs[0].i), price: hl.at(highs[0].i) }, to: { time: T(t), price: hl.at(t) } },
          { from: { time: T(lows[0].i), price: ll.at(lows[0].i) }, to: { time: T(t), price: ll.at(t) } },
        ];
        if (upBreak) add(`${kind.name} breakout up`, "bull", "confirmed", lines);
        else if (dnBreak) add(`${kind.name} breakdown`, "bear", "confirmed", lines);
        else if (c.close <= hl.at(t) + 0.2 * atr && c.close >= ll.at(t) - 0.2 * atr) add(kind.name, kind.bias, "forming", lines);
      }
    }
  }

  // Support / resistance: swing prices that price has turned at 3+ times in the last ~300 candles.
  const recent = piv.filter((p) => p.confirmedAt <= t && p.i >= t - 300);
  const levels: { price: number; touches: number; first: number }[] = [];
  for (const p of recent) {
    const lv = levels.find((l) => Math.abs(l.price - p.price) <= 0.35 * atr);
    if (lv) {
      lv.price = (lv.price * lv.touches + p.price) / (lv.touches + 1);
      lv.touches += 1;
      lv.first = Math.min(lv.first, p.i);
    } else levels.push({ price: p.price, touches: 1, first: p.i });
  }
  const strong = levels.filter((l) => l.touches >= 3);
  const above = strong.filter((l) => l.price > c.close).sort((x, y) => x.price - y.price)[0];
  const below = strong.filter((l) => l.price <= c.close).sort((x, y) => y.price - x.price)[0];
  const level = (l: { price: number; first: number }) => [{ from: { time: T(l.first), price: l.price }, to: { time: T(t), price: l.price } }];
  for (const l of strong) {
    if (prev.close <= l.price && c.close > l.price + 0.1 * atr) add("Resistance breakout", "bull", "confirmed", level(l));
    if (prev.close >= l.price && c.close < l.price - 0.1 * atr) add("Support breakdown", "bear", "confirmed", level(l));
  }
  if (above && above.price - c.close <= 1.0 * atr) add("Near resistance", "bear", "forming", level(above));
  if (below && c.close - below.price <= 1.0 * atr) add("Near support", "bull", "forming", level(below));

  return out;
}

// ── Measuring patterns on history ─────────────────────────────────────

export interface PatternStat {
  key: string;
  bias: Bias;
  n: number; //          times it appeared
  greenNext: number; //  share of next candles that closed green
  move5: number; //      average 5-candle move after it, ATR units (signed)
  edge: number; //       shrunk log-odds shift for "next candle green" vs the base rate (0 = no information)
}

export interface PatternBook {
  base: number; // share of all candles that were green in the measured stretch
  stats: Map<string, PatternStat>;
  measuredCandles: number;
}

const logit = (p: number) => Math.log(Math.min(0.999, Math.max(0.001, p)) / (1 - Math.min(0.999, Math.max(0.001, p))));

/** The pivots that matter at candle t (confirmed by t, recent enough), found by binary search. */
export function pivotWindow(piv: Pivot[], t: number, size = 80): Pivot[] {
  let lo = 0;
  let hi = piv.length; // first pivot confirmed after t
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (piv[mid].confirmedAt <= t) lo = mid + 1;
    else hi = mid;
  }
  return piv.slice(Math.max(0, lo - size), lo);
}

/** Every pattern key active at candle t (candlestick names and chart pattern keys). */
export function patternKeysAt(cs: Candle[], t: number, atr: number, piv: Pivot[]): { key: string; bias: Bias }[] {
  return [
    ...candlePatterns(cs, t, atr).map((p) => ({ key: p.name, bias: p.bias })),
    ...chartPatterns(cs, t, atr, pivotWindow(piv, t)).map((p) => ({ key: p.key, bias: p.bias })),
  ];
}

/**
 * What each pattern has been worth on candles [from, to): next-candle green rate and 5-candle move.
 * Rates are shrunk toward the base rate with `prior` pseudo-observations, so a pattern seen 20 times
 * barely moves the forecast and only a well-measured difference counts.
 */
export function measurePatterns(cs: Candle[], from: number, to: number, prior = 100): PatternBook {
  const atrs = wilderAtr(cs);
  const piv = pivots(cs, atrs);
  const acc = new Map<string, { bias: Bias; n: number; g: number; m: number }>();
  let greens = 0;
  let total = 0;
  for (let t = Math.max(from, 30); t < Math.min(to, cs.length - 5); t++) {
    const atr = atrs[t];
    if (!atr) continue;
    const nxt = cs[t + 1];
    if (nxt.close === nxt.open) continue;
    const isGreen = nxt.close > nxt.open ? 1 : 0;
    greens += isGreen;
    total += 1;
    const move5 = (cs[t + 5].close - cs[t].close) / atr;
    for (const { key, bias } of patternKeysAt(cs, t, atr, piv)) {
      const s = acc.get(key) ?? { bias, n: 0, g: 0, m: 0 };
      s.n += 1;
      s.g += isGreen;
      s.m += move5;
      acc.set(key, s);
    }
  }
  const base = total ? greens / total : 0.5;
  const stats = new Map<string, PatternStat>();
  for (const [key, s] of acc) {
    const shrunk = (s.g + prior * base) / (s.n + prior);
    stats.set(key, { key, bias: s.bias, n: s.n, greenNext: s.g / s.n, move5: s.m / s.n, edge: logit(shrunk) - logit(base) });
  }
  return { base, stats, measuredCandles: total };
}

/** Sum of measured edges for the patterns active now (log-odds units; 0 = patterns say nothing). */
export function patternEdge(book: PatternBook, keys: { key: string }[]): number {
  return keys.reduce((a, k) => a + (book.stats.get(k.key)?.edge ?? 0), 0);
}
