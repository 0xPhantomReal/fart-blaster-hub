import { describe, expect, it } from "vitest";
import { JevFixer, scoreArrow, type Tally } from "./jevfix";

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296), seed / 4294967296);
}

describe("Jev refined", () => {
  it("starts by trusting Jev exactly", () => {
    const f = new JevFixer();
    expect(f.predict(0.7, undefined)).toBeCloseTo(0.7, 5);
  });

  it("learns a consistent bias out of Jev (walk-forward) and beats raw Jev", () => {
    const raw: Tally = { right: 0, n: 0 };
    const fixed: Tally = { right: 0, n: 0 };
    for (const seed of [1, 2, 3, 7, 11]) {
      const r = rng(seed);
      const f = new JevFixer();
      for (let i = 0; i < 600; i++) {
        const y = (r() < 0.5 ? 1 : 0) as 0 | 1;
        // Jev knows something (60% right) but is far too bullish: it adds +0.15 to every answer.
        const pJev = ((r() < 0.6 ? y : 1 - y) === 1 ? 0.6 : 0.4) + 0.15;
        const x = Array.from({ length: 19 }, () => r() - 0.5); // irrelevant signals
        if (i >= 300) {
          scoreArrow(raw, pJev, y);
          scoreArrow(fixed, f.predict(pJev, x), y);
        }
        f.update(pJev, x, y);
      }
      expect(f.summary().bias).toBeLessThan(-0.1); // learned "Jev is too bullish"
    }
    expect(fixed.right / fixed.n).toBeGreaterThan(raw.right / raw.n + 0.03);
  });

  it("leaves a well-calibrated Jev roughly alone", () => {
    const r = rng(3);
    const f = new JevFixer();
    for (let i = 0; i < 400; i++) {
      const y = (r() < 0.5 ? 1 : 0) as 0 | 1;
      f.update((r() < 0.6 ? y : 1 - y) === 1 ? 0.6 : 0.4, undefined, y);
    }
    expect(Math.abs(f.summary().bias)).toBeLessThan(0.25);
    expect(f.predict(0.6, undefined)).toBeGreaterThan(0.53);
  });

  it("learns to stop fighting a trend within ~150 candles", () => {
    const raw: Tally = { right: 0, n: 0 };
    const fixed: Tally = { right: 0, n: 0 };
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed);
      const f = new JevFixer();
      for (let i = 0; i < 200; i++) {
        // A steady uptrend: 62% of candles green. Jev keeps expecting pullbacks: 60% of its calls say red.
        const y = (r() < 0.62 ? 1 : 0) as 0 | 1;
        const pJev = r() < 0.6 ? 0.42 : 0.58;
        const x = Array.from({ length: 19 }, () => (r() - 0.5) * 0.3);
        x[15] = 2 + (r() - 0.5) * 0.5; // trend_last_20: strong uptrend
        x[16] = 2.5 + (r() - 0.5) * 0.5;
        x[18] = 0.12;
        if (i >= 50) {
          scoreArrow(raw, pJev, y);
          scoreArrow(fixed, f.predict(pJev, x), y);
        }
        f.update(pJev, x, y);
      }
    }
    expect(fixed.right / fixed.n).toBeGreaterThan(raw.right / raw.n + 0.1);
  });
});
