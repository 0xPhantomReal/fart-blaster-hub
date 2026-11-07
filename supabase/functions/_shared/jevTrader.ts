// Jev as the trader (FADEBOT_STRATEGY = jev-trader): one question per moment, asked straight to TypeSafe (no hop through
// the gold function, so asking constantly doesn't run into Supabase's function-to-function rate limit).
// Jev gets everything — the candle, Lightspeed, candle strength, the live market block, Polymarket's prices and our
// position — and answers what to do now, plus its own chance the candle closes green.

const URL_ = () => Deno.env.get("TYPESAFE_URL") || "https://api.typesafe.ai/v1/systemone";

async function ask(state: Record<string, unknown>, questions: Record<string, unknown>) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(URL_(), {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${Deno.env.get("TYPESAFE_API_KEY") ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: Deno.env.get("JEV_MODEL") || "jev-latest", state, questions }),
    });
    if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const r = await res.json();
    return (r?.answers ?? {}) as Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
  } finally {
    clearTimeout(timer);
  }
}

const RULES =
  "You are trading Polymarket US's 5-minute bitcoin Up/Down market for the candle in candle_so_far. An Up share pays " +
  "$1 if the window settles Up (BRTI at the end ≥ BRTI at the start; candle_so_far tracks it as green), else $0; a " +
  "Down share pays $1 if it settles Down. polymarket gives what one share costs to buy right now (up_cost, down_cost) " +
  "and what it sells for (up_sell, down_sell). A buy is only worth it when your chance of that side winning is clearly " +
  "above its cost — the price already includes what everyone can see on the chart, so look for what the price is " +
  "missing (order flow, books, futures, other coins, how much time is left versus how far price is from the open). ";

const FINISH_GUIDE =
  "Start from lightspeed.finish_probability.random_walk_p_green_pct (the pure-math chance of green from here) and " +
  "move away only for real evidence: lightspeed_live (books, aggressive trade flow, futures, other coins), " +
  "candle_strength, momentum and the last 40 candles.";

/** Jev's answer: what to do now, and its chance the candle closes green (both from one call when possible). */
export async function askJevTrader(state: Record<string, unknown>, holding: boolean) {
  const trade = holding
    ? {
      type: "choice",
      instructions:
        RULES +
        "You HOLD the position in position (side, shares, average cost, what it sells for now, unrealized P&L, time " +
        "held). Should you SELL it all now at the sell price, or HOLD it (to settlement or a later sale)? Sell when " +
        "your chance of it winning is below what it sells for, or the reason you bought is gone; hold when it is still " +
        "worth more than its sell price. " + FINISH_GUIDE,
      criteria: {
        sell: "Sell the whole position now at the current sell price",
        hold: "Keep the position",
      },
    }
    : {
      type: "choice",
      instructions:
        RULES +
        "You hold nothing in this window. Should you BUY UP now, BUY DOWN now, or WAIT? Only buy when your chance of " +
        "that side winning beats its cost by a clear margin; otherwise wait. " + FINISH_GUIDE,
      criteria: {
        buy_up: "Buy Up shares now at up_cost",
        buy_down: "Buy Down shares now at down_cost",
        wait: "Do nothing right now",
      },
    };
  const finish = {
    type: "choice",
    instructions: "Will this 5-minute candle (candle_so_far) close green (end ≥ open) or red? " + FINISH_GUIDE,
    criteria: { green: "It closes at or above its open", red: "It closes below its open" },
  };
  // Both questions in one call; if the API only answers one question per call, ask them side by side.
  let a = await ask(state, { trade, finish }).catch(() => ({}) as Awaited<ReturnType<typeof ask>>);
  if (!a.trade?.choice || !a.finish?.probabilities) {
    const [t, f] = await Promise.all([ask(state, { q: trade }), ask(state, { q: finish })]);
    a = { trade: t.q, finish: f.q };
  }
  const action = a.trade?.choice;
  const valid = holding ? ["sell", "hold"] : ["buy_up", "buy_down", "wait"];
  if (typeof action !== "string" || !valid.includes(action)) throw new Error("unexpected TypeSafe response shape");
  const g = a.finish?.probabilities?.green;
  return {
    action: action as "buy_up" | "buy_down" | "wait" | "sell" | "hold",
    actionProbs: a.trade?.probabilities ?? {},
    pUp: typeof g === "number" ? g : null,
    confidence: typeof a.trade?.confidence === "number" ? a.trade.confidence : null,
  };
}
