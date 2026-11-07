// Backtest of the Polymarket bot's EMA rule on past candles, from the page's "Jev at …" reads:
//   EMAs at least $gap apart: bet with Jev's call (hold or flip) when the EMAs agree (up: fast above slow)
//   EMAs closer than that: with Jev when the EMAs agree (a flip also needs the last candle the other color); else none
// EMAs are the TV indicator's (9/21, Pine's EMA) on this chart's candles, taken live at the read: the closed-candle
// EMA moved by the candle's price at the read (its open + the move so far), as the chart draws the live lines.

import { emaSeries, TV_INPUTS } from "./tvIndicator";

export interface Read {
  time: number;
  open: number; //   the candle's open
  move: number; //   price at the read − open (its sign = the color at the read)
  pJev: number; //   Jev's chance of green at the read
  y: 0 | 1 | null; // how the candle closed: 1 green, 0 red, null flat
  regime?: string; // the regime at the read: normal (Jev right) / backwards / unsure
  last?: 0 | 1 | null; // the previous candle's color: 1 green, 0 red, null flat/unknown
}

export interface Tally {
  n: number;
  wins: number;
}
export interface Backtest {
  bot: Tally; //       every bet the rule makes
  flips: Tally; //     of which: flip calls that agreed with the EMAs
  holdsEma: Tally; //  of which: hold calls that agreed with the EMAs
  chop: Tally; //      of which: EMAs close, a hold call the EMAs agree with → with Jev
  chopFlips: Tally; // of which: EMAs close, a flip the EMAs agree with, last candle the other color → with Jev
  holdsAll: Tally; //  every hold call followed, no EMA check (for comparison)
  flipsAll: Tally; //  every flip call followed, no EMA check (for comparison)
  skippedHolds: number; // hold calls skipped because the EMAs disagreed
  skippedFlips: number; // flip calls skipped because the EMAs disagreed
  skippedFlipsRegime: number; // flip calls skipped because the regime wasn't "Jev right"
}

/** EMA fast/slow at the read of each candle, by candle time. `closes` = all chart candles' closes, oldest first. */
export function emasAtReads(
  candles: { time: number; close: number }[],
  reads: Read[],
): Map<number, { fast: number; slow: number }> {
  const close = candles.map((c) => c.close);
  const f = emaSeries(close, TV_INPUTS.emaFastLen);
  const s = emaSeries(close, TV_INPUTS.emaSlowLen);
  const idx = new Map(candles.map((c, i) => [c.time, i]));
  const out = new Map<number, { fast: number; slow: number }>();
  const af = 2 / (TV_INPUTS.emaFastLen + 1);
  const as = 2 / (TV_INPUTS.emaSlowLen + 1);
  for (const r of reads) {
    const i = idx.get(r.time);
    if (i === undefined || i === 0) continue;
    const pf = f[i - 1];
    const ps = s[i - 1];
    if (pf === null || ps === null) continue;
    const p = r.open + r.move;
    out.set(r.time, {
      fast: af * p + (1 - af) * pf,
      slow: as * p + (1 - as) * ps,
    });
  }
  return out;
}

export function backtest(
  reads: Read[],
  emas: Map<number, { fast: number; slow: number }>,
  minGap = 0, // the EMAs must be at least this many dollars apart
  flipNeedsRegime = false, // flip bets only in the "Jev right" regime
): Backtest {
  const t = (): Tally => ({ n: 0, wins: 0 });
  const out: Backtest = {
    bot: t(),
    flips: t(),
    holdsEma: t(),
    chop: t(),
    chopFlips: t(),
    holdsAll: t(),
    flipsAll: t(),
    skippedHolds: 0,
    skippedFlips: 0,
    skippedFlipsRegime: 0,
  };
  const add = (x: Tally, up: boolean, y: 0 | 1) => {
    x.n += 1;
    if (up === (y === 1)) x.wins += 1;
  };
  for (const r of reads) {
    if (r.y === null || r.pJev === 0.5 || r.move === 0) continue;
    const e = emas.get(r.time);
    if (!e) continue; // no EMA for that candle: leave it out of every row
    const y = r.y;
    const jevUp = r.pJev > 0.5;
    const flip = jevUp !== r.move > 0;
    if (!flip) add(out.holdsAll, jevUp, y);
    else add(out.flipsAll, jevUp, y);
    if (Math.abs(e.fast - e.slow) < minGap - 1e-9) {
      // EMAs close: with Jev when the EMAs agree; a flip also needs the last candle the other color from the call
      const agree = (jevUp && e.fast > e.slow) || (!jevUp && e.fast < e.slow);
      const ok = agree && (!flip || r.last === (jevUp ? 0 : 1));
      if (ok) {
        add(flip ? out.chopFlips : out.chop, jevUp, y);
        add(out.bot, jevUp, y);
      } else if (flip) out.skippedFlips += 1;
      else out.skippedHolds += 1;
      continue;
    }
    const agree = (jevUp && e.fast > e.slow) || (!jevUp && e.fast < e.slow);
    if (!agree) {
      if (flip) out.skippedFlips += 1;
      else out.skippedHolds += 1;
      continue;
    }
    if (flip && flipNeedsRegime && r.regime !== "normal") {
      out.skippedFlipsRegime += 1;
      continue;
    }
    add(out.bot, jevUp, y); // with Jev's call
    add(flip ? out.flips : out.holdsEma, jevUp, y);
  }
  return out;
}
