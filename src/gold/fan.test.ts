import { describe, expect, it } from "vitest";
import { AnalogIndex } from "./forecast";
import { backtestFan, buildFan, calibrateFan, FanTracker, jevWeights } from "./fan";
import type { Candle } from "./indicators";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** Random-walk candles with slowly changing volatility, plus an optional reversal after big candles. */
function history(n: number, fade = 0, seed = 21): Candle[] {
  const r = rng(seed);
  const out: Candle[] = [];
  let p = 4000;
  for (let i = 0; i < n; i++) {
    const vol = 1 + 0.5 * Math.sin(i / 300);
    const prev = out[out.length - 1];
    const prevBig = prev ? Math.abs(prev.close - prev.open) > 2.2 * vol : false;
    let body = gauss(r) * vol;
    if (prevBig && fade > 0 && r() < fade) body = -Math.sign(prev!.close - prev!.open) * Math.abs(body);
    const o = p;
    const c = o + body;
    out.push({ time: 1_700_000_100 - (1_700_000_100 % 900) + i * 900, open: o, close: c, high: Math.max(o, c) + r() * vol * 0.5, low: Math.min(o, c) - r() * vol * 0.5 });
    p = c;
  }
  return out;
}

describe("forecast fan", () => {
  it("bands are ordered and widen with each step", () => {
    const idx = new AnalogIndex(history(6000));
    const fan = buildFan(idx.scenarios(5999, 2000)!);
    for (const s of fan.steps) expect(s.p10 <= s.p25 && s.p25 <= s.p50 && s.p50 <= s.p75 && s.p75 <= s.p90).toBe(true);
    const width = fan.steps.map((s) => s.p90 - s.p10);
    expect(width[4]).toBeGreaterThan(width[0]);
  });

  it("is calibrated on a random walk: the 80% band holds ~80%, the 50% band ~50%", async () => {
    const score = (await backtestFan(new AnalogIndex(history(8000)), { windows: 300, spacing: 5, paths: 1000, yieldEvery: 1e9 })).score!;
    console.log(`random walk: in80 ${(score.in80 * 100).toFixed(1)}%, in50 ${(score.in50 * 100).toFixed(1)}%, center skill ${score.centerSkill.toFixed(3)}`);
    expect(score.in80).toBeGreaterThan(0.72);
    expect(score.in80).toBeLessThan(0.88);
    expect(score.in50).toBeGreaterThan(0.42);
    expect(score.in50).toBeLessThan(0.58);
    expect(score.centerSkill).toBeLessThan(0.05); // nothing to predict, and it doesn't pretend otherwise
  });

  it("picks up a real pattern: after big candles, the middle line beats 'no move'", async () => {
    const h = history(12000, 0.9);
    const idx = new AnalogIndex(h);
    // Score only the moments right after a big candle, where the pattern applies.
    const big = (t: number) => Math.abs(h[t].close - h[t].open) > 2.2 * (1 + 0.5 * Math.sin(t / 300));
    const score = (await backtestFan(idx, { windows: 6000, spacing: 1, paths: 150, yieldEvery: 1e9, when: big })).score!;
    console.log(`after big candles: ${score.windows} windows, center skill ${score.centerSkill.toFixed(3)}, direction skill ${score.directionSkill.toFixed(3)}`);
    expect(score.windows).toBeGreaterThan(50);
    expect(score.centerSkill).toBeGreaterThan(0.03);
  });

  it("Jev's ratings tilt the fan but can't collapse it", () => {
    const set = new AnalogIndex(history(6000)).scenarios(5999, 500)!;
    const up = set.scenarios.filter((s) => s.candles.reduce((a, c) => a + c.body, 0) > 0);
    const ratings = Object.fromEntries(set.scenarios.map((s) => [s.id, up.includes(s) ? 2 / 250 : 0.0001]));
    const plain = buildFan(set);
    const tilted = buildFan(set, jevWeights(set, ratings));
    expect(tilted.endsHigher).toBeGreaterThan(plain.endsHigher + 0.1);
    expect(tilted.endsHigher).toBeLessThan(0.95);
    expect(tilted.steps[4].p90 - tilted.steps[4].p10).toBeGreaterThan(0.3 * (plain.steps[4].p90 - plain.steps[4].p10));
  });

  it("tracker scores a perfect-middle forecast as beating 'no move'", () => {
    const t = new FanTracker();
    const fan = { steps: Array.from({ length: 5 }, (_, k) => ({ p10: k - 1, p25: k - 0.5, p50: k, p75: k + 0.5, p90: k + 1, pGreen: 0.6 })), endsHigher: 0.9 };
    t.record(fan, [0, 1, 2, 3, 4]);
    const s = t.summary()!;
    expect(s.in80).toBe(1);
    expect(s.centerSkill).toBe(1);
  });

  it("calibration fixes bands that are too narrow, on data it hasn't seen", async () => {
    // Volatility jumps up in the second half, so bands learned from calm history are too narrow.
    const h = history(10000, 0, 33).map((c, i) => {
      if (i < 7000) return c;
      const mid = (c.open + c.close) / 2;
      const k = 1.8;
      return { ...c, open: mid + (c.open - mid) * k, close: mid + (c.close - mid) * k, high: mid + (c.high - mid) * k, low: mid + (c.low - mid) * k };
    });
    // Re-chain so each candle opens at the previous close.
    let p = h[0].open;
    const chained = h.map((c) => {
      const d = p - c.open;
      p = c.close + d;
      return { ...c, open: c.open + d, close: c.close + d, high: c.high + d, low: c.low + d };
    });
    const idx = new AnalogIndex(chained);
    // Learn the stretch on 8000–8800, then check on 8800–9990.
    const learn = new FanTracker();
    const check = { raw: new FanTracker(), fixed: new FanTracker() };
    for (let t = 8000; t < 9990; t += 5) {
      const set = idx.scenarios(t, 800);
      const atr = idx.atrs[t]!;
      const actual = Array.from({ length: 5 }, (_, k) => (chained[t + 1 + k].close - chained[t].close) / atr);
      const fan = buildFan(set!);
      if (t < 8800) learn.record(fan, actual);
      else {
        check.raw.record(fan, actual);
        check.fixed.record(calibrateFan(fan, learn.calibration() ?? { k50: 1, k80: 1 }), actual);
      }
    }
    const raw = check.raw.summary()!.in80;
    const fixed = check.fixed.summary()!.in80;
    console.log(`80% band on unseen data: raw ${(raw * 100).toFixed(1)}%, calibrated ${(fixed * 100).toFixed(1)}%`);
    expect(Math.abs(fixed - 0.8)).toBeLessThan(Math.abs(raw - 0.8));
  });
});
