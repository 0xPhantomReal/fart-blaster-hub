import { describe, expect, it } from "vitest";
import { trendLabel, trendRegimes } from "./trendRegime";
import { trendSummary } from "../../supabase/functions/_shared/fadeStrategy";

function walk(n: number, seed: number, drift = 0) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  let p = 75000;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    const c = o + (rnd() - 0.5) * 80 + drift;
    p = c;
    return { time: 1e9 + i * 300, open: o, high: Math.max(o, c) + rnd() * 20, low: Math.min(o, c) - rnd() * 20, close: c };
  });
}

describe("trend shading", () => {
  it("labels exactly like the bot's trendSummary", () => {
    for (const [seed, drift] of [[3, 0], [11, -25], [29, 25], [41, -8]] as const) {
      const cs = walk(200, seed, drift);
      for (let i = 30; i < cs.length; i += 7) {
        const closed = cs.slice(i - 12, i);
        const args = [cs[i].open, cs[i].open + 5, cs[i].open - 3, 40] as const;
        expect(trendLabel(closed, ...args).label).toBe(trendSummary(closed, ...args).label);
      }
    }
  });
  it("a steady slide is mostly strong downtrend, a steady climb strong uptrend", () => {
    const down = trendRegimes(walk(300, 7, -30));
    const up = trendRegimes(walk(300, 7, 30));
    const share = (m: Map<number, { label: string }>, l: string) => [...m.values()].filter((x) => x.label === l).length / m.size;
    expect(share(down, "strong downtrend")).toBeGreaterThan(0.6);
    expect(share(up, "strong uptrend")).toBeGreaterThan(0.6);
  });
});
