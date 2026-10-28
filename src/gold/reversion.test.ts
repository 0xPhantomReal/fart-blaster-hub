import { describe, expect, it } from "vitest";
import { fitReversion, reversionAt } from "./reversion";
import { Engine } from "./model";
import type { Candle } from "./indicators";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/**
 * 1-minute bars for `n` 15-minute candles. In the first 5 minutes price jumps by J; over the
 * remaining 10 minutes it gives back `revert` × J, plus noise. jumpScale = 0 is a plain random walk.
 */
function minuteBars(n: number, revert: number, seed = 3, jumpScale = 2): Candle[] {
  const r = rng(seed);
  const out: Candle[] = [];
  let p = 4000;
  const t0 = 1_700_000_100 - (1_700_000_100 % 900);
  for (let c = 0; c < n; c++) {
    const jump = gauss(r) * jumpScale;
    for (let k = 0; k < 15; k++) {
      const step = (k < 5 ? jump / 5 : (-revert * jump) / 10) + gauss(r) * 0.3;
      const o = p;
      p += step;
      out.push({ time: t0 + c * 900 + k * 60, open: o, high: Math.max(o, p) + 0.05, low: Math.min(o, p) - 0.05, close: p });
    }
  }
  return out;
}

const fifteen = (mins: Candle[]): Candle[] => {
  const out: Candle[] = [];
  for (let i = 0; i < mins.length; i += 15) {
    const g = mins.slice(i, i + 15);
    out.push({ time: g[0].time, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[14].close });
  }
  return out;
};

describe("intra-candle mean reversion", () => {
  it("finds no reversion in a random walk", () => {
    const fit = fitReversion(minuteBars(1500, 0, 3, 0), 900)!;
    expect(fit.candles).toBeGreaterThan(1400);
    for (const e of [3, 5, 8, 12]) expect(Math.abs(fit.hold[e] - 1)).toBeLessThan(0.12);
    expect(fit.spread[15]).toBe(0);
  });

  it("measures planted reversion: half of an early jump given back", () => {
    const fit = fitReversion(minuteBars(1500, 0.5), 900)!;
    expect(fit.hold[5]).toBeGreaterThan(0.4);
    expect(fit.hold[5]).toBeLessThan(0.6);
    // Later in the candle the reversion has already happened, so what's left holds more.
    expect(reversionAt(fit, 14).hold).toBeGreaterThan(0.85);
  });

  it("using the measured reversion makes the live probability more accurate", () => {
    const mins = minuteBars(2000, 0.6, 9);
    const fit = fitReversion(mins.slice(0, 15 * 1000), 900)!; // fit on the first half only
    const candles = fifteen(mins);
    const brier = (useFit: boolean) => {
      const e = new Engine(900, 0.56, 300);
      e.reversion = useFit ? fit : null;
      let sum = 0;
      let n = 0;
      candles.forEach((c, i) => {
        if (i >= 1000) {
          // Live read 5 minutes in, scored on the second half (data the fit never saw).
          const g = mins.slice(i * 15, i * 15 + 5);
          const f = { time: c.time, open: c.open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[4].close };
          const live = e.nowcast(f, c.time + 300);
          if (live && c.close !== c.open) {
            sum += (live.pGreen - (c.close > c.open ? 1 : 0)) ** 2;
            n += 1;
          }
        }
        e.close(c);
      });
      return sum / n;
    };
    const withFit = brier(true);
    const randomWalk = brier(false);
    console.log(`live Brier score at minute 5: measured reversion ${withFit.toFixed(4)} vs random walk ${randomWalk.toFixed(4)}`);
    expect(withFit).toBeLessThan(randomWalk);
  });
});
