import { describe, expect, it } from "vitest";
import { lightspeedFadeDecision, takeProfitPrice } from "../../supabase/functions/_shared/fadeStrategy";

const ls = (move: number, typical: number) => ({ finish_probability: { move_dollars: move, typical_move_in_time_left_dollars: typical } });

describe("Lightspeed fade", () => {
  it("bets against a move bigger than the typical move, inside the first 2 minutes", () => {
    expect(lightspeedFadeDecision(ls(60, 50), 45)).toMatchObject({ side: "down" });
    expect(lightspeedFadeDecision(ls(-60, 50), 119)).toMatchObject({ side: "up" });
  });
  it("no bet when the move is within the typical move, after 2 minutes, or without numbers", () => {
    expect("skip" in lightspeedFadeDecision(ls(50, 50), 30)).toBe(true);
    expect("skip" in lightspeedFadeDecision(ls(-20, 50), 30)).toBe(true);
    expect("skip" in lightspeedFadeDecision(ls(90, 50), 120)).toBe(true);
    expect("skip" in lightspeedFadeDecision(null, 30)).toBe(true);
  });
  it("take profit is double the buy price, none when that's $1 or more", () => {
    expect(takeProfitPrice(0.22)).toBe(0.44);
    expect(takeProfitPrice(0.5)).toBeNull();
    expect(takeProfitPrice(0.61)).toBeNull();
  });
});
