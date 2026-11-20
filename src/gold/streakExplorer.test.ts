import { describe, expect, it } from "vitest";
import { analyse } from "./StreakExplorer";
import type { StatsReplayTrade } from "./feed";

const tr = (i: number, won: boolean, f: Record<string, number | string | boolean | null>) =>
  ({ window: 1000 + i * 300, at: 170, won, pnl: won ? 10 : -10, side: "up", quote: 40, paid: 50, f } as unknown as StatsReplayTrade);

describe("losing streak explorer", () => {
  it("finds streaks and the conditions over-represented in them", () => {
    const T = [
      tr(0, true, { quoteAge: 2 }),
      tr(1, false, { quoteAge: 30 }),
      tr(2, false, { quoteAge: 30 }),
      tr(3, false, { quoteAge: 30 }),
      tr(4, true, { quoteAge: 2 }),
      tr(5, false, { quoteAge: 2 }),
      tr(6, true, { quoteAge: 2 }),
    ];
    const a = analyse(T, 3);
    expect(a.streaks.length).toBe(1);
    expect(a.streaks[0].length).toBe(3);
    const old = a.rows.find((r) => r.bucket === "21–40 s")!;
    expect(old.n).toBe(3);
    expect(old.inStreak).toBe(3);
    expect(old.lift).toBeCloseTo((3 / 3) / (3 / 7));
    expect(analyse(T, 2).streaks.length).toBe(1);
    expect(analyse(T, 1).streaks.length).toBe(2);
  });
});
