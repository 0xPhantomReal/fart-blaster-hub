// Backtest of the Polymarket bot's EMA rule on past candles, from the page's "Jev at …" reads:
//   Jev calls a flip → bet with Jev's call (the flip)
//   Jev calls a hold up with the fast EMA above the slow EMA → bet up; hold down with fast below slow → bet down
// EMAs are the TV indicator's (9/21, Pine's EMA) on this chart's candles, taken live at the read: the closed-candle
// EMA moved by the candle's price at the read (its open + the move so far), as the chart draws the live lines.

import { emaSeries, TV_INPUTS } from "./tvIndicator";

export interface Read {
  time: number;
  open: number; //   the candle's open
  move: number; //   price at the read − open (its sign = the color at the read)
  pJev: number; //   Jev's chance of green at the read
  y: 0 | 1 | null; // how the candle closed: 1 green, 0 red, null flat
}

export interface Tally {
  n: number;
  wins: number;
}
export interface Backtest {
  bot: Tally; //       every bet the rule makes
  flips: Tally; //     of which: flip calls, bet with Jev
  holdsEma: Tally; //  of which: hold calls that agreed with the EMAs
  holdsAll: Tally; //  every hold call followed, no EMA check (for comparison)
  skippedHolds: number; // hold calls skipped because the EMAs disagreed
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
): Backtest {
  const t = (): Tally => ({ n: 0, wins: 0 });
  const out: Backtest = {
    bot: t(),
    flips: t(),
    holdsEma: t(),
    holdsAll: t(),
    skippedHolds: 0,
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
    const greenNow = r.move > 0;
    if (jevUp !== greenNow) {
      add(out.flips, jevUp, y); // flip → with Jev's call
      add(out.bot, jevUp, y);
      continue;
    }
    add(out.holdsAll, jevUp, y);
    if ((jevUp && e.fast > e.slow) || (!jevUp && e.fast < e.slow)) {
      add(out.holdsEma, jevUp, y);
      add(out.bot, jevUp, y);
    } else out.skippedHolds += 1;
  }
  return out;
}
