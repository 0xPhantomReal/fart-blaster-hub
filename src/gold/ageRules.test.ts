import { describe, expect, it } from "vitest";
import { ageAllowed, marketPick, parseAgeRules, quoteAge } from "../../supabase/functions/_shared/marketPick";

const RULES = parseAgeRules("0-2:none;3-5:50-99;6-10:20-29;11-15:0-19;16-20:0-19;21+:all");

describe("quote-age rules", () => {
  it("parses the six brackets", () => {
    expect(RULES.length).toBe(6);
    expect(RULES[0]).toEqual({ lo: 0, hi: 2, allow: [] });
    expect(RULES[5]).toEqual({ lo: 21, hi: Infinity, allow: null });
  });
  it("applies each bracket", () => {
    const ok = (age: number, c: number) => ageAllowed(age, c / 100, RULES).ok;
    expect([ok(0, 15), ok(2, 55)]).toEqual([false, false]); // 0–2 s: nothing
    expect([ok(3, 50), ok(5, 49)]).toEqual([true, false]); // 3–5 s: 50¢+
    expect([ok(6, 25), ok(10, 30), ok(8, 19)]).toEqual([true, false, false]); // 6–10 s: 20–29¢
    expect([ok(11, 19), ok(15, 20)]).toEqual([true, false]); // 11–15 s: under 20¢
    expect([ok(16, 5), ok(20, 45)]).toEqual([true, false]); // 16–20 s: under 20¢
    expect([ok(21, 80), ok(60, 3)]).toEqual([true, true]); // 21 s+: all
  });
  it("measures age as seconds the quote has gone unchanged", () => {
    const hist = [
      { at: 100, up: 0.4, down: 0.61 },
      { at: 102, up: 0.45, down: 0.56 },
      { at: 104, up: 0.45, down: 0.56 },
      { at: 106, up: 0.45, down: 0.56 },
    ];
    expect(quoteAge(hist, { at: 108, cost: 0.45 }, "up")).toBe(6);
    expect(quoteAge(hist, { at: 108, cost: 0.5 }, "up")).toBe(0);
    expect(quoteAge(hist, { at: 108, cost: 0.56 }, "down")).toBe(6);
  });
  it("marketPick blocks a buy its rule doesn't allow, and asks again", () => {
    const cfg = {
      minSec: 0,
      ageRules: RULES,
      stats: false,
      statsCfg: { minN: 15, slip: 0.09, minEdge: 0.05, fee: 0.095, invert: false, swapAbove: 0, maxAgainst: 0 },
      invert: false,
      skipJevPct: [],
      skipRanges: [],
      swap: false,
      swapRanges: [],
    };
    const call = { buy: "up" as const, p: 0.7, cost: 0.35, upCost: 0.35, downCost: 0.66, dist: null, at: 110 };
    // 35¢ quote unchanged for 8 s → 6–10 s rule allows only 20–29¢
    const hist = [{ at: 102, up: 0.35, down: 0.66 }, { at: 106, up: 0.35, down: 0.66 }];
    const r = marketPick({ ...call, quoteHist: hist }, cfg, null);
    expect(r.kind).toBe("wait");
    expect(r.kind === "wait" && r.why).toContain("FADEBOT_TRADER_AGE_RULES");
    // 25 s old → 21 s+ allows all
    const ok = marketPick({ ...call, quoteHist: [{ at: 85, up: 0.35, down: 0.66 }] }, cfg, null);
    expect(ok.kind === "buy" && ok.note).toContain("25 s old");
  });
});
