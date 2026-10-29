import { describe, expect, it } from "vitest";
import { FlipBlender, flipState, greenFromFlip, liveMath, pastSnapshots } from "./flip";
import type { Candle } from "./indicators";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const T0 = 1_700_000_100 - (1_700_000_100 % 900);

describe("flip check", () => {
  it("math: a big lead late in the candle almost never flips; early, it's close to a coin toss", () => {
    expect(liveMath(0.5, 3, 2, 0.05)).toBeGreaterThan(0.95);
    expect(liveMath(0.5, 0.2, 2, 0.95)).toBeLessThan(0.6);
  });

  it("Jev's flip chance becomes a chance of green the right way round", () => {
    expect(greenFromFlip(+1, 0.2)).toBeCloseTo(0.8);
    expect(greenFromFlip(-1, 0.2)).toBeCloseTo(0.2);
  });

  it("what Jev sees has no prices, no dates and no math", () => {
    const st = flipState({
      forming: { time: T0, open: 4012.3, high: 4014.1, low: 4011.8, close: 4013.6 },
      secondsLeft: 400,
      tfSeconds: 900,
      atr: 3,
      sd: 2.4,
      previous: [{ time: T0 - 900, open: 4010, high: 4013, low: 4009, close: 4012.3 }],
    })!;
    const text = JSON.stringify(st);
    expect(text).not.toMatch(/401\d/);
    expect(text).not.toMatch(/time"/);
    expect(st.current_color).toBe("green");
    expect(text).not.toMatch(/p_?green|math/i);
  });

  it("the blend learns to lean on a Jev that's better than the math", () => {
    const r = rng(5);
    const b = new FlipBlender();
    const rows = Array.from({ length: 400 }, () => {
      const y = (r() < 0.5 ? 1 : 0) as 0 | 1;
      const right = r() < 0.7;
      return { pMath: 0.5, pJev: (y === 1) === right ? 0.7 : 0.3, move: r() < 0.5 ? 1 : -1, y };
    });
    b.backfill(rows);
    expect(b.weights.jev).toBeGreaterThan(0.5);
    expect(b.blend(0.5, 0.7)).toBeGreaterThan(0.6);
  });

  it("counts flips caught and false alarms", () => {
    const b = new FlipBlender();
    const rec = b.backfill([
      { pMath: 0.2, pJev: 0.8, move: +1, y: 1 }, // green held: math raised a false alarm, Jev said holds
      { pMath: 0.9, pJev: 0.3, move: +1, y: 0 }, // green flipped red: Jev caught it, math missed
      { pMath: 0.4, pJev: 0.6, move: -1, y: 0 }, // red held: Jev raised a false alarm
    ]);
    expect(rec.n).toBe(3);
    expect(rec.jev).toEqual({ flips: 1, caught: 1, alarms: 1 });
    expect(rec.math).toEqual({ flips: 1, caught: 0, alarms: 1 });
  });

  it("rebuilds past candles partway through from 1-minute bars", () => {
    const r = rng(2);
    const minutes: Candle[] = [];
    const closed: Candle[] = [];
    let p = 4000;
    for (let c = 0; c < 200; c++) {
      const t = T0 + c * 900;
      const open = p;
      let hi = p;
      let lo = p;
      for (let k = 0; k < 15; k++) {
        const o = p;
        p += (r() - 0.5) * 2;
        hi = Math.max(hi, p);
        lo = Math.min(lo, p);
        minutes.push({ time: t + k * 60, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p });
      }
      closed.push({ time: t, open, high: hi, low: lo, close: p });
    }
    const snaps = pastSnapshots(minutes, closed, 900, () => 3, () => 0.5, 150);
    expect(snaps.length).toBeGreaterThan(100);
    for (const s of snaps) {
      expect(s.pMath).toBeGreaterThan(0);
      expect(["green", "red"]).toContain(s.state.current_color);
    }
  });
});
