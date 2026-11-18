import { describe, expect, it } from "vitest";
import { confirmGate, marketPick } from "../../supabase/functions/_shared/marketPick";

describe("bias + confirmation", () => {
  it("first call sets the bias and is not bought", () => {
    const g = confirmGate([], { at: 40, pick: "up" }, 60);
    expect(g.ok).toBe(false);
  });
  it("waits until the confirmation time", () => {
    const g = confirmGate([{ at: 40, pick: "up" }], { at: 80, pick: "up" }, 60);
    expect(g.ok).toBe(false);
  });
  it("confirms when the first call after the wait agrees", () => {
    const g = confirmGate([{ at: 40, pick: "up" }, { at: 70, pick: "down" }], { at: 100, pick: "up" }, 60);
    expect(g.ok).toBe(true);
  });
  it("a disagreeing call becomes the new bias and the wait starts again", () => {
    const g = confirmGate([{ at: 40, pick: "up" }], { at: 101, pick: "down" }, 60);
    expect(g.why).toContain("bias flipped");
    const early = confirmGate([{ at: 40, pick: "up" }, { at: 101, pick: "down" }], { at: 130, pick: "down" }, 60);
    expect(early.ok).toBe(false);
    const ok = confirmGate([{ at: 40, pick: "up" }, { at: 101, pick: "down" }], { at: 165, pick: "down" }, 60);
    expect(ok.ok).toBe(true);
    const again = confirmGate([{ at: 40, pick: "up" }, { at: 101, pick: "down" }], { at: 165, pick: "up" }, 60);
    expect(again.why).toContain("bias flipped");
  });
  it("after confirming, other-side calls wait", () => {
    const g = confirmGate([{ at: 40, pick: "up" }, { at: 100, pick: "up" }], { at: 130, pick: "down" }, 60);
    expect(g.ok).toBe(false);
  });
  it("marketPick applies it before the other rules", () => {
    const cfg = {
      minSec: 0,
      confirmSec: 60,
      stats: false,
      statsCfg: { minN: 15, slip: 0.09, minEdge: 0.05, fee: 0.095, invert: false, swapAbove: 0, maxAgainst: 0 },
      invert: false,
      skipJevPct: [],
      skipRanges: [],
      swap: false,
      swapRanges: [],
    };
    const call = { buy: "up" as const, p: 0.7, cost: 0.4, upCost: 0.4, downCost: 0.61, dist: null };
    expect(marketPick({ ...call, at: 40, earlier: [] }, cfg, null).kind).toBe("wait");
    const r = marketPick({ ...call, at: 105, earlier: [{ at: 40, pick: "up" }] }, cfg, null);
    expect(r.kind === "buy" && r.side).toBe("up");
    expect(r.kind === "buy" && r.note).toContain("confirmed");
  });
});

import { streak15Block } from "../../supabase/functions/_shared/marketPick";
describe("15-minute streak block", () => {
  it("blocks when the newest n results match", () => {
    expect(streak15Block(["up", "up", "up", "down"], 3)).toEqual({ blocked: true, side: "up", run: 3 });
    expect(streak15Block(["up", "up", "down", "up"], 3).blocked).toBe(false);
    expect(streak15Block(["down", "down", "down", "down", "up"], 3).run).toBe(4);
  });
  it("never blocks on missing results or when off", () => {
    expect(streak15Block([null, "up", "up", "up"], 3).blocked).toBe(false);
    expect(streak15Block(["up", null, "up", "up"], 3).blocked).toBe(false);
    expect(streak15Block(["up", "up", "up"], 0).blocked).toBe(false);
  });
});

import { parseSecRange } from "../../supabase/functions/_shared/marketPick";
describe("confirmation time range", () => {
  const R = parseSecRange("160-189");
  it("parses seconds", () => {
    expect(R).toEqual({ lo: 160, hi: 189 });
    expect(parseSecRange("200+")).toEqual({ lo: 200, hi: 300 });
    expect(parseSecRange("")).toBeNull();
  });
  it("trades only when the confirmation lands in the range", () => {
    const early = confirmGate([{ at: 30, pick: "up" }], { at: 152, pick: "up" }, 120, R);
    expect(early.ok).toBe(false);
    expect(early.why).toContain("no trade this window");
    // a later call in the same window stays blocked: the confirmation was at 152 s
    const later = confirmGate([{ at: 30, pick: "up" }, { at: 152, pick: "up" }], { at: 170, pick: "up" }, 120, R);
    expect(later.ok).toBe(false);
    const inside = confirmGate([{ at: 45, pick: "up" }], { at: 168, pick: "up" }, 120, R);
    expect(inside.ok).toBe(true);
    const late = confirmGate([{ at: 75, pick: "up" }], { at: 200, pick: "up" }, 120, R);
    expect(late.ok).toBe(false);
  });
});

describe("triple confirmation (bias → warm → buy)", () => {
  it("needs a warm call and then a buy call, each after its wait", () => {
    const W = [60, 30];
    expect(confirmGate([{ at: 30, pick: "up" }], { at: 95, pick: "up" }, W).ok).toBe(false); // 95 is the warm call
    expect(confirmGate([{ at: 30, pick: "up" }, { at: 95, pick: "up" }], { at: 110, pick: "up" }, W).ok).toBe(false); // too soon
    const ok = confirmGate([{ at: 30, pick: "up" }, { at: 95, pick: "up" }], { at: 126, pick: "up" }, W);
    expect(ok.ok).toBe(true);
    expect(ok.note).toContain("warm at 95 s");
  });
  it("a disagreeing warm or buy call becomes the new bias", () => {
    const W = [60, 30];
    const g = confirmGate([{ at: 30, pick: "up" }, { at: 95, pick: "up" }], { at: 126, pick: "down" }, W);
    expect(g.why).toContain("bias flipped");
    const again = confirmGate(
      [{ at: 30, pick: "up" }, { at: 95, pick: "up" }, { at: 126, pick: "down" }, { at: 190, pick: "down" }],
      { at: 221, pick: "down" },
      W,
    );
    expect(again.ok).toBe(true);
  });
  it("a single wait behaves exactly like before", () => {
    expect(confirmGate([{ at: 40, pick: "up" }], { at: 101, pick: "up" }, [60]).ok).toBe(true);
    expect(confirmGate([{ at: 40, pick: "up" }], { at: 101, pick: "up" }, 60).ok).toBe(true);
  });
});
