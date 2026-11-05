// Backtest of the Polymarket bot's rule on past candles: fade Jev's minute-X call when it's in the bot's range, but
// only when the call goes against the TradingView indicator on 15-minute candles (so the bet goes with the indicator).

import type { Candle } from "./indicators";
import { runTvIndicator } from "./tvIndicator";

export interface Read {
  time: number; //  candle open time
  pJev: number; //  Jev's chance of green at the read
  y: 0 | 1 | null; // how the candle closed: 1 green, 0 red, null flat
}

/** The 15m indicator's call at any moment: the call made at the last 15-minute close before it. */
export class Tv15 {
  private closes: number[] = [];
  private dirs: (-1 | 0 | 1)[] = [];
  constructor(candles15: Candle[]) {
    const r = runTvIndicator(candles15, null);
    for (const b of r.bars) {
      this.closes.push(b.time + 900);
      this.dirs.push(b.bias);
    }
  }
  get size() {
    return this.closes.length;
  }
  /** -1 red, 0 no call, 1 green, null = no 15m candle closed before `t` in the data. */
  at(t: number): -1 | 0 | 1 | null {
    let lo = 0;
    let hi = this.closes.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.closes[mid] <= t) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return k < 0 ? null : this.dirs[k];
  }
}

export interface Tally {
  n: number;
  wins: number;
}
export interface Backtest {
  bot: Tally; //        the bot's rule: fade in range AND Jev against the 15m indicator
  fadeAll: Tally; //    fade every in-range call (no 15m check)
  jevInRange: Tally; // follow Jev on the same in-range calls
  tvAlone: Tally; //    follow the 15m indicator whenever it has a call
  skippedAgree: number; // in-range calls skipped because the indicator agreed with Jev
  skippedNoCall: number; // … because the indicator showed no call
}

export function backtest(
  reads: Read[],
  tv: Tv15,
  readSec: number,
  min: number,
  max: number,
): Backtest {
  const t = (): Tally => ({ n: 0, wins: 0 });
  const out: Backtest = {
    bot: t(),
    fadeAll: t(),
    jevInRange: t(),
    tvAlone: t(),
    skippedAgree: 0,
    skippedNoCall: 0,
  };
  const add = (x: Tally, up: boolean, y: 0 | 1) => {
    x.n += 1;
    if (up === (y === 1)) x.wins += 1;
  };
  for (const r of reads) {
    if (r.y === null || r.pJev === 0.5) continue;
    const ind = tv.at(r.time + readSec);
    if (ind === null) continue; // no indicator data for that time: leave the candle out of every row
    const y = r.y;
    if (ind !== 0) add(out.tvAlone, ind === 1, y);
    const sure = Math.max(r.pJev, 1 - r.pJev);
    if (sure < min - 1e-9 || sure > max + 1e-9) continue;
    const jevUp = r.pJev > 0.5;
    add(out.fadeAll, !jevUp, y);
    add(out.jevInRange, jevUp, y);
    if (ind === 0) out.skippedNoCall += 1;
    else if ((ind === 1) === jevUp) out.skippedAgree += 1;
    else add(out.bot, ind === 1, y); // fade Jev = go with the indicator
  }
  return out;
}
