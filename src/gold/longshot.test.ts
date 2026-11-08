import { describe, expect, it } from "vitest";
import { depthDollars, longshotDecision, normCdf, settleProbability } from "../../supabase/functions/_shared/longshot";

const base = { startRef: 100000, end: 1000, price: 100000, knownAvg: null, knownSec: 0, sigmaPerSec: 2, safety: 1, feedSd: 0 };
const CFG = { minCost: 0.85, maxCost: 0.99, minProb: 0.995, margin: 0.01, feePerShare: 0, windowSec: 90, stopSec: 3 };

describe("longshot settlement model", () => {
  it("normCdf", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(2.5758)).toBeCloseTo(0.995, 4);
  });
  it("at the start ref with time left → 50%", () => {
    expect(settleProbability({ ...base, now: 900 }).pUp).toBeCloseTo(0.5, 6);
  });
  it("closing-minute variance: random-walk average is σ²·T/3", () => {
    const r = settleProbability({ ...base, now: 940 }); // closing minute starts now, nothing known
    expect(r.sd).toBeCloseTo(Math.sqrt(4 * 60 / 3), 6);
    const g = settleProbability({ ...base, now: 900 }); // 40 s gap before it
    expect(g.sd).toBeCloseTo(Math.sqrt(4 * (40 + 20)), 6);
  });
  it("what's already averaged in counts: 45 s in at +$30 avg, price back at the ref → still very likely Up", () => {
    const r = settleProbability({ ...base, now: 985, knownSec: 45, knownAvg: 100030, price: 100000 });
    expect(r.expectedFinal).toBeCloseTo(100022.5, 6);
    expect(r.pUp).toBeGreaterThan(0.999);
  });
  it("safety factor and feed error lower the certainty", () => {
    const x = { ...base, now: 970, knownSec: 30, knownAvg: 100012, price: 100008 };
    const a = settleProbability(x).pUp;
    const b = settleProbability({ ...x, safety: 2, feedSd: 3 }).pUp;
    expect(b).toBeLessThan(a);
  });
});

describe("longshot decision", () => {
  it("buys a near-certain side priced 85–99¢ with margin, late only", () => {
    expect(longshotDecision({ pUp: 0.999 }, { upCost: 0.95, downCost: 0.06 }, 40, CFG)).toEqual({ side: "up", p: 0.999, cost: 0.95 });
    expect(longshotDecision({ pUp: 0.001 }, { upCost: 0.06, downCost: 0.9 }, 40, CFG)).toMatchObject({ side: "down", cost: 0.9 });
  });
  it("refuses: too early, not sure enough, outside the band, no margin, too late", () => {
    expect(longshotDecision({ pUp: 0.999 }, { upCost: 0.95, downCost: 0.06 }, 120, CFG)).toHaveProperty("none");
    expect(longshotDecision({ pUp: 0.99 }, { upCost: 0.9, downCost: 0.11 }, 40, CFG)).toHaveProperty("none");
    expect(longshotDecision({ pUp: 0.999 }, { upCost: 0.8, downCost: 0.21 }, 40, CFG)).toHaveProperty("none");
    expect(longshotDecision({ pUp: 0.996 }, { upCost: 0.99, downCost: 0.02 }, 40, CFG)).toHaveProperty("none");
    expect(longshotDecision({ pUp: 0.999 }, { upCost: 0.95, downCost: 0.06 }, 2, CFG)).toHaveProperty("none");
  });
  it("depth: dollars available at or under the max cost", () => {
    const book = { bids: [[0.1, 50], [0.08, 100]] as [number, number][], offers: [[0.95, 10], [0.96, 20], [0.98, 100]] as [number, number][] };
    expect(depthDollars(book, "up", true, 0.96)).toBeCloseTo(0.95 * 10 + 0.96 * 20, 6);
    expect(depthDollars(book, "down", true, 0.91)).toBeCloseTo(0.9 * 50, 6); // NO at 1 − 0.10
  });
});
