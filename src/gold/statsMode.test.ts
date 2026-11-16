import { describe, expect, it } from "vitest";
import {
  distBand,
  pctBand,
  perDollar,
  priceBand,
  countSamples,
  statsDecide,
  statsPick,
  type StatsSample,
} from "../../supabase/functions/_shared/statsMode";

const cfg = { minN: 10, slip: 0.09, minEdge: 0.05, fee: 0.095 };
const mk = (n: number, o: Partial<StatsSample>, winsForPick: number): StatsSample[] =>
  Array.from({ length: n }, (_, i) => ({
    window: i * 300,
    pick: "up",
    pct: 0.58,
    jevCost: 0.3,
    otherCost: 0.71,
    dist: 10,
    winner: i < winsForPick ? "up" : "down",
    ...o,
  }));

describe("stats mode bands", () => {
  it("bands Jev %, price and BTC position", () => {
    expect(pctBand(0.55)).toBe("50–55%");
    expect(pctBand(0.65)).toBe("61–65%");
    expect(pctBand(0.9)).toBe("81–100%");
    expect(priceBand(0.3)).toBe("30–39¢");
    expect(priceBand(0.299)).toBe("30–39¢");
    expect(priceBand(0.19)).toBe("under 20¢");
    expect(distBand(-40)).toBe("BTC $25+ against him");
    expect(distBand(-3)).toBe("BTC $0–25 against him");
    expect(distBand(30)).toBe("BTC $25+ with him");
    expect(distBand(null)).toBeNull();
  });
  it("prices profit per $1 with fees", () => {
    expect(perDollar(0.5, true, 0.095)).toBeCloseTo(0.9525, 4);
    expect(perDollar(0.5, false, 0.095)).toBeCloseTo(-1.0475, 4);
  });
});

describe("statsDecide", () => {
  const call = { pct: 0.58, jevCost: 0.3, otherCost: 0.71, dist: 10 };
  it("goes WITH Jev when his past calls in the same conditions paid after the price gap", () => {
    // 20 calls at 30c (+9c gap = 39c): 12 right → clearly profitable with him
    const d = statsDecide(call, countSamples(mk(20, {}, 12)), cfg);
    expect(d.choice).toBe("with");
    expect(d.level).toBe("% + price + BTC");
    expect(d.n).toBe(20);
    expect(d.why).toContain("WITH");
  });
  it("goes AGAINST Jev when the other side pays at today's price", () => {
    // Jev right only 2 of 20 → the other side wins 90%; today it costs 71c (+9c = 80c) → still profitable
    const d = statsDecide(call, countSamples(mk(20, {}, 2)), cfg);
    expect(d.choice).toBe("against");
  });
  it("prices the choice at today's quotes, not the past ones", () => {
    // the other side won 90% in the past, but today it costs 88c (+9c = 97c): no longer worth it
    const d = statsDecide({ ...call, otherCost: 0.88 }, countSamples(mk(20, {}, 2)), cfg);
    expect(d.choice).toBe("skip");
  });
  it("skips when neither side beat the minimum", () => {
    const d = statsDecide(call, countSamples(mk(20, {}, 7)), cfg);
    expect(d.choice).toBe("skip");
  });
  it("widens the bands when the exact ones are too thin, then skips with too little history", () => {
    const wide = [...mk(4, {}, 4), ...mk(16, { pct: 0.75 }, 10)];
    const d = statsDecide(call, countSamples(wide), cfg);
    expect(d.level).toBe("price + BTC");
    expect(d.n).toBe(20);
    const none = statsDecide(call, countSamples(mk(5, {}, 5)), cfg);
    expect(none.choice).toBe("skip");
    expect(none.level).toBe("none");
  });
  it("ignores BTC position when it's unknown", () => {
    const d = statsDecide({ ...call, dist: null }, countSamples(mk(20, { dist: null }, 12)), cfg);
    expect(d.level).toBe("% + price");
    expect(d.choice).toBe("with");
  });
});

describe("statsPick", () => {
  const cfg = { minN: 10, slip: 0.09, minEdge: 0.05, fee: 0.095 };
  const call = { pick: "up" as const, pct: 0.7, jevCost: 0.3, otherCost: 0.7, dist: 10 };
  it("with Jev, then invert, swap above and the wrong-side skip, in the live order", () => {
    const c = countSamples(mk(20, {}, 12));
    const a = statsPick(call, c, { ...cfg, invert: false, swapAbove: 0, maxAgainst: 0 });
    expect(a.buy && a.side).toBe("up");
    const b = statsPick(call, c, { ...cfg, invert: true, swapAbove: 0, maxAgainst: 0 });
    expect(b.buy && b.side).toBe("down");
    const s = statsPick(call, c, { ...cfg, invert: true, swapAbove: 0.61, maxAgainst: 0 });
    expect(s.buy && s.side).toBe("up");
    const k = statsPick(call, c, { ...cfg, invert: true, swapAbove: 0, maxAgainst: 5 });
    expect(k.buy).toBe(false);
  });
  it("swaps when the price is in a stats swap range", () => {
    const c = countSamples(mk(20, {}, 12));
    const base = { ...cfg, invert: false, swapAbove: 0, maxAgainst: 0 };
    const r = statsPick(call, c, { ...base, swapRanges: [{ lo: 0.25, hi: 0.35 }] });
    expect(r.buy && r.side).toBe("down");
    expect(r.buy && r.cost).toBe(0.7);
    expect(r.note).toContain("stats swap range");
    const n = statsPick(call, c, { ...base, swapRanges: [{ lo: 0.4, hi: 0.5 }] });
    expect(n.buy && n.side).toBe("up");
  });
});
