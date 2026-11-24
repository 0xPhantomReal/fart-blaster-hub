// Pump bot: one question to Jev (TypeSafe) — will this cheap side win at settlement?
import { ask } from "./jevTrader.ts";
import type { PumpFeatures, PumpScore } from "./pumpCore.ts";

/** The question Jev is asked before a buy: the chance this side wins at settlement (whatever the exit settings). */
export function askJevPump(f: PumpFeatures, sc: PumpScore, extra: Record<string, unknown> = {}) {
  return askJevHold(f, sc, extra);
}

/**
 * Hold-to-resolution question: will this cheap side WIN at settlement? (The bot holds every buy to the end, so the
 * only thing that matters is the final result, not a bounce.) Returns the win probability as pPump.
 */
async function askJevHold(f: PumpFeatures, sc: PumpScore, extra: Record<string, unknown>) {
  const ask_c = f.ask_c ?? 0;
  const side = f.side === "up" ? "Up" : "Down";
  const rule = f.side === "up" ? "at or above" : "below";
  const q = {
    type: "choice",
    instructions:
      "You are judging a bet on Polymarket US's 5-minute bitcoin Up/Down market. An Up share pays $1 if the window " +
      "settles Up (BRTI averaged over the window's last minute is at or above price_to_beat), a Down share pays $1 if " +
      `it settles Down. We would BUY the ${side.toUpperCase()} side now at its ask of ${ask_c}¢; held to resolution ` +
      "it pays $1 a share if it wins, nothing if it loses. The market's price says it wins " +
      `about ${ask_c}% of the time. Will the window settle ${side} — bitcoin's last-minute average ${rule} the price ` +
      "to beat? Judge it from: bitcoin versus the price to beat and how far it has to move (btc: " +
      "dollars_against_this_side, sigmas_to_flip = how many typical moves over the time left bitcoin is from " +
      "flipping), bitcoin's volatility and recent moves, bitcoin order flow on Coinbase spot and the Hyperliquid perp " +
      "(aggressive buying/selling, order-flow imbalance, microprice — the next move), the fair chance from bitcoin's " +
      "distance and volatility (fair_chance_from_btc), this side's Polymarket book and trade flow, and seconds_left. " +
      `The bot's microstructure read scored this ${sc.score}/100 (flow ${sc.parts.flow}, thin offers ${sc.parts.thin}, ` +
      `bids ${sc.parts.bids}, turn ${sc.parts.turn}, bitcoin ${sc.parts.btc}). Be realistic: a cheap side is usually ` +
      "cheap because it's losing, and the price is usually about right. Answer win or lose, and give your real " +
      "probability that it wins — the bet only pays if that's above the price.",
    criteria: {
      win: `The window settles ${side} (bitcoin's last-minute average ${rule} the price to beat)`,
      lose: `It settles ${f.side === "up" ? "Down" : "Up"}`,
    },
  };
  const a = await ask({ ...f, microstructure_score: sc, ...extra }, { win: q });
  const ans = a.win;
  if (!ans || (ans.choice !== "win" && ans.choice !== "lose")) throw new Error("unexpected TypeSafe response shape");
  const p = ans.probabilities?.win;
  return {
    choice: ans.choice === "win" ? "pump" as const : "no" as const,
    pPump: typeof p === "number" ? p : ans.choice === "win" ? 1 : 0,
    confidence: typeof ans.confidence === "number" ? ans.confidence : null,
  };
}

/** Seesaw: will this side's bid reach the price that breaks even after both fees, before the window ends? */
export async function askJevBreakeven(
  f: PumpFeatures,
  sc: PumpScore,
  beC: number,
  extra: Record<string, unknown> = {},
  context = "",
) {
  const ask_c = f.ask_c ?? 0;
  const side = f.side === "up" ? "Up" : "Down";
  const q = {
    type: "choice",
    instructions:
      "You are grading a quick trade on Polymarket US's 5-minute bitcoin Up/Down market. We would BUY the " +
      `${side.toUpperCase()} side now at market (ask ${ask_c}¢) and try to SELL it back into the bid later in this ` +
      `window. After both fees and the spread, it only breaks even if this side's BID reaches ${beC}¢. Will the bid ` +
      `reach ${beC}¢ at any point before the window ends (seconds_left)? A cheap side's bid only rises that far when ` +
      "bitcoin moves toward this side (Up wants bitcoin above price_to_beat, Down below) or buyers lift its book. " +
      "Judge it from: bitcoin's distance from the price to beat and its volatility over the time left " +
      "(btc: dollars_against_this_side, sigmas_to_flip, vol_per_sqrt_sec), its latest moves and order flow on " +
      "Coinbase spot and the Hyperliquid perp (aggressive buying/selling, order-flow imbalance, microprice), this " +
      "side's Polymarket book (bids_top10, asks_top10, depth, imbalance) and trade flow, how fast its price has been " +
      "moving (price_moves, ask_trace), and seconds_left. " +
      `The bot's microstructure score is ${sc.score}/100 (flow ${sc.parts.flow}, thin offers ${sc.parts.thin}, bids ` +
      `${sc.parts.bids}, turn ${sc.parts.turn}, bitcoin ${sc.parts.btc}). Be realistic: the round trip costs about a ` +
      "fifth of the price, so the bid has to rise well above where it is now. Answer reach or no, with your real " +
      "probability that it reaches the break-even." + (context ? " " + context : ""),
    criteria: {
      reach: `This side's bid reaches ${beC}¢ before the window ends`,
      no: `It doesn't reach ${beC}¢`,
    },
  };
  const a = await ask({ ...f, microstructure_score: sc, break_even_bid_c: beC, ...extra }, { be: q });
  const ans = a.be;
  if (!ans || (ans.choice !== "reach" && ans.choice !== "no")) throw new Error("unexpected TypeSafe response shape");
  const p = ans.probabilities?.reach;
  return { choice: ans.choice as "reach" | "no", p: typeof p === "number" ? p : ans.choice === "reach" ? 1 : 0 };
}
