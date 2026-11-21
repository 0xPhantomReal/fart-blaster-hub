// Pump bot: one question to Jev (TypeSafe) — can this cheap side double from its ask before the stop or the end?
import { ask } from "./jevTrader.ts";
import type { PumpFeatures, PumpScore } from "./pumpCore.ts";

export async function askJevPump(f: PumpFeatures, sc: PumpScore, extra: Record<string, unknown> = {}) {
  const ask_c = f.ask_c ?? 0;
  const q = {
    type: "choice",
    instructions:
      "You are judging a short scalp on Polymarket US's 5-minute bitcoin Up/Down market. An Up share pays $1 if the " +
      "window settles Up (BRTI over the last minute ≥ price_to_beat), a Down share pays $1 if it settles Down. We " +
      `would BUY the ${f.side.toUpperCase()} side now at its ask of ${ask_c}¢ and SELL as soon as its bid reaches ` +
      `${f.target_bid_c}¢ (+100%). If its bid falls to ${f.stop_bid_c}¢ (−50%) we cut it, and with a few seconds left ` +
      "we sell at whatever it's worth. Will the bid reach the target before the stop and before the window ends? " +
      "Judge it from the microstructure and volatility: the order book (book: depth near the ask and bid, how many " +
      "offers sit between the ask and 2× — thin offers above mean a small wave of buying lifts it; bid/ask imbalance), " +
      "trade flow (flow_10s/30s/60s: aggressive buying of this side versus selling), how fast and how far this side's " +
      "price has been moving (price_moves, ask_trace), bitcoin versus the price to beat and its volatility (btc: " +
      "dollars_against_this_side, recent moves, vol_per_sqrt_sec, sigmas_to_flip = how many typical moves over the " +
      "time left bitcoin is from flipping to this side), and seconds_left. A cheap side doubles when bitcoin swings " +
      "back toward the price to beat or the book gets lifted; it rarely does with little time left, bitcoin far away " +
      "and quiet, or sellers in control. " +
      `The bot's own microstructure read (microstructure_score) scored this ${sc.score}/100 — flow ${sc.parts.flow}, ` +
      `thin offers ${sc.parts.thin}, bids stacking ${sc.parts.bids}, price turning ${sc.parts.turn}, bitcoin ` +
      `${sc.parts.btc} (20 each) — which is why you're being asked; check it against the raw book (bids_top10, ` +
      "asks_top10) and flow yourself. Be realistic: most cheap sides don't double. Answer pump or no, and give your " +
      "real probability of pump (the bot buys at its own threshold, not at 50%).",
    criteria: {
      pump: `The bid reaches ${f.target_bid_c}¢ before ${f.stop_bid_c}¢ and before the end`,
      no: "It doesn't",
    },
  };
  const a = await ask({ ...f, microstructure_score: sc, ...extra }, { pump: q });
  const ans = a.pump;
  if (!ans || (ans.choice !== "pump" && ans.choice !== "no")) throw new Error("unexpected TypeSafe response shape");
  const p = ans.probabilities?.pump;
  return {
    choice: ans.choice as "pump" | "no",
    pPump: typeof p === "number" ? p : ans.choice === "pump" ? 1 : 0,
    confidence: typeof ans.confidence === "number" ? ans.confidence : null,
  };
}
