import { describe, expect, it } from "vitest";
import { candlePatterns, chartPatterns, measurePatterns, patternEdge, patternKeysAt, pivots, wilderAtr } from "./patterns";
import type { Candle } from "./indicators";

const T0 = 1_700_000_100 - (1_700_000_100 % 900);
/** Build candles from [open, high, low, close] tuples. */
const mk = (rows: [number, number, number, number][]): Candle[] =>
  rows.map(([open, high, low, close], i) => ({ time: T0 + i * 900, open, high, low, close }));
const names = (cs: Candle[], atr = 1) => candlePatterns(cs, cs.length - 1, atr).map((p) => p.name);

describe("candlestick patterns", () => {
  const falling: [number, number, number, number][] = [
    [104, 104.2, 102.8, 103],
    [103, 103.2, 101.8, 102],
    [102, 102.2, 100.8, 101],
  ];
  const rising: [number, number, number, number][] = [
    [96, 97.2, 95.8, 97],
    [97, 98.2, 96.8, 98],
    [98, 99.2, 97.8, 99],
  ];

  it("hammer after a decline, hanging man after a rise", () => {
    expect(names(mk([...falling, [101, 101.25, 99.5, 101.2]]))).toContain("Hammer");
    expect(names(mk([...rising, [99, 99.25, 97.5, 99.2]]))).toContain("Hanging man");
  });

  it("shooting star after a rise", () => {
    expect(names(mk([...rising, [99, 100.7, 98.95, 98.8]]))).toContain("Shooting star");
  });

  it("bullish and bearish engulfing", () => {
    expect(names(mk([...falling.slice(0, 2), [102, 102.1, 101.4, 101.5], [101.5, 102.6, 101.4, 102.5]]))).toContain("Bullish engulfing");
    expect(names(mk([...rising.slice(0, 2), [98, 98.6, 97.9, 98.5], [98.5, 98.6, 97.4, 97.5]]))).toContain("Bearish engulfing");
  });

  it("doji, morning star, three white soldiers", () => {
    expect(names(mk([...falling, [101, 101.4, 100.6, 101.02]]))).toContain("Doji");
    expect(names(mk([[105, 105.1, 104, 104.2], [104.2, 104.3, 103, 103.1], [103.1, 103.2, 102.9, 103.0], [103.0, 104.2, 102.95, 104.1]]))).toContain("Morning star");
    expect(names(mk([[99, 99.1, 98.9, 99], [99, 99.75, 98.95, 99.7], [99.7, 100.45, 99.65, 100.4], [100.4, 101.15, 100.35, 101.1]]))).toContain("Three white soldiers");
  });

  it("ordinary candles trigger nothing", () => {
    expect(names(mk([...rising, [99, 99.6, 98.6, 99.3]]))).toEqual([]);
  });
});

/** Price path from waypoints, one candle per step, small candles in between. */
function path(points: number[], perLeg = 8): Candle[] {
  const closes: number[] = [];
  for (let k = 0; k < points.length - 1; k++)
    for (let j = 0; j < perLeg; j++) closes.push(points[k] + ((points[k + 1] - points[k]) * (j + 1)) / perLeg);
  let prev = points[0];
  return closes.map((c, i) => {
    const o = prev;
    prev = c;
    return { time: T0 + i * 900, open: o, close: c, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05 };
  });
}

describe("chart patterns", () => {
  it("finds a double top and confirms it when the neckline breaks", () => {
    const cs = path([100, 110, 104, 110.1, 103]);
    const atrs = wilderAtr(cs);
    const piv = pivots(cs, atrs, 1.5);
    const found = cs.map((_, t) => (atrs[t] ? chartPatterns(cs, t, atrs[t]!, piv) : [])).flat();
    expect(found.some((p) => p.name === "Double top" && p.status === "forming")).toBe(true);
    expect(found.some((p) => p.name === "Double top" && p.status === "confirmed")).toBe(true);
  });

  it("finds a head & shoulders", () => {
    const cs = path([100, 108, 104, 112, 104.2, 108.2, 102]);
    const atrs = wilderAtr(cs);
    const piv = pivots(cs, atrs, 1.5);
    const found = cs.map((_, t) => (atrs[t] ? chartPatterns(cs, t, atrs[t]!, piv) : [])).flat();
    expect(found.some((p) => p.name === "Head & shoulders")).toBe(true);
  });

  it("finds a symmetrical triangle", () => {
    const cs = path([100, 112, 102, 110, 104, 108.5, 105.2, 107.4, 106], 7);
    const atrs = wilderAtr(cs);
    const piv = pivots(cs, atrs, 1.0);
    const found = cs.map((_, t) => (atrs[t] ? chartPatterns(cs, t, atrs[t]!, piv) : [])).flat();
    expect(found.some((p) => p.name.startsWith("Symmetrical triangle"))).toBe(true);
  });

  it("pivots are only used after they are confirmed (no peeking)", () => {
    const cs = path([100, 110, 104, 110.1, 103]);
    const atrs = wilderAtr(cs);
    const piv = pivots(cs, atrs, 1.5);
    for (const p of piv) expect(p.confirmedAt).toBeGreaterThan(p.i);
  });
});

describe("measuring patterns", () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }
  /** Random candles, but after a bullish engulfing the next candle is green 75% of the time. */
  function history(n: number): Candle[] {
    const r = rng(9);
    const out: Candle[] = [];
    let p = 4000;
    for (let i = 0; i < n; i++) {
      const tmp = out.slice();
      let dir = r() < 0.5 ? 1 : -1;
      if (tmp.length > 30) {
        const atr = wilderAtr(tmp.slice(-40)).at(-1)!;
        if (candlePatterns(tmp, tmp.length - 1, atr).some((x) => x.name === "Bullish engulfing")) dir = r() < 0.75 ? 1 : -1;
      }
      const b = (0.2 + r() * 1.2) * dir;
      const o = p;
      const c = o + b;
      out.push({ time: T0 + i * 900, open: o, close: c, high: Math.max(o, c) + r() * 0.4, low: Math.min(o, c) - r() * 0.4 });
      p = c;
    }
    return out;
  }

  it("measures a real edge and ignores noise", () => {
    const cs = history(8000);
    const book = measurePatterns(cs, 0, cs.length);
    const eng = book.stats.get("Bullish engulfing")!;
    console.log(`bullish engulfing: n=${eng.n}, next green ${(eng.greenNext * 100).toFixed(1)}%, edge ${eng.edge.toFixed(3)}`);
    expect(eng.n).toBeGreaterThan(80);
    expect(eng.greenNext).toBeGreaterThan(0.65);
    expect(eng.edge).toBeGreaterThan(0.2);
    // A pattern with no planted effect should get a small edge after shrinkage.
    const bear = book.stats.get("Bearish engulfing");
    if (bear) expect(Math.abs(bear.edge)).toBeLessThan(0.2);
    const t = cs.length - 6;
    expect(Number.isFinite(patternEdge(book, patternKeysAt(cs, t, wilderAtr(cs)[t]!, pivots(cs, wilderAtr(cs)))))).toBe(true);
  });
});
