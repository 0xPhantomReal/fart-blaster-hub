import { describe, expect, it } from "vitest";
import { autoReplay } from "../../supabase/functions/_shared/autoReplay";

function slide(n: number, step: number) {
  return Array.from({ length: n }, (_, i) => {
    const o = 80000 + i * step;
    return { time: 1e9 + i * 300, open: o, high: Math.max(o, o + step * 0.8) + 3, low: Math.min(o, o + step * 0.8) - 3, close: o + step * 0.8 };
  });
}
const minutes = (c5: { time: number; open: number; close: number }[]) =>
  c5.flatMap((c) => Array.from({ length: 5 }, (_, k) => {
    const o = c.open + ((c.close - c.open) * k) / 5;
    const cl = c.open + ((c.close - c.open) * (k + 1)) / 5;
    return { time: c.time + k * 60, open: o, high: Math.max(o, cl), low: Math.min(o, cl), close: cl };
  }));

describe("auto replay", () => {
  it("strong downtrend → straight with Jev; matches the actual trade side when it bought Jev's pick", () => {
    const c5 = slide(200, -20);
    const w = c5[150].time;
    const r = autoReplay(c5, minutes(c5), [{ window: w, atSec: 60, pUp: 0.2 }], [
      { window: w, side: "up", status: "settled", result: "loss", pnl: -30 },
    ]);
    expect(r.rows[0]).toMatchObject({ jevPick: "down", label: "strong downtrend", auto: "straight", autoWatch: "down", sameSide: false });
    expect(r.summary.trades_auto_other_side).toEqual({ trades: 1, wins: 0, losses: 1, pnl: -30 });
  });
  it("no clear trend → flip (watch the other side)", () => {
    const c5 = Array.from({ length: 200 }, (_, i) => {
      const o = 80000 + (i % 2 ? 15 : -15);
      return { time: 1e9 + i * 300, open: o, high: o + 20, low: o - 20, close: o + (i % 2 ? -10 : 10) };
    });
    const w = c5[150].time;
    const r = autoReplay(c5, minutes(c5), [{ window: w, atSec: 30, pUp: 0.7 }], []);
    expect(r.rows[0]).toMatchObject({ jevPick: "up", auto: "flip", autoWatch: "down", actual: null });
  });
});
