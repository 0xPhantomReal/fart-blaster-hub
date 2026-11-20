/**
 * Market buys (FADEBOT_TRADER_ORDER=market): everything that happens to a call AFTER traderDecision said "buy",
 * in the live bot's order. The live bot and the replay (backtest) both run this, so they decide alike.
 *
 *   too early (FADEBOT_TRADER_MIN_SEC)                     → wait (ask again)
 *   confirmation (FADEBOT_TRADER_CONFIRM_SEC): the window's first call sets the bias and is not bought; the first
 *     call at least CONFIRM_SEC later confirms it (same side) or becomes the new bias (other side) and the wait
 *     starts again; once confirmed, calls on the bias side go on   → wait
 *   stats mode on: statsPick (with / against / skip, invert, swap above, wrong-side skip)
 *   stats mode off:
 *     Jev % in a skip range (FADEBOT_TRADER_SKIP_JEV_PCT)  → wait
 *     live-price ban hit (hybrid; worked out by the caller) → wait
 *     side: Jev's, or the other side with FADEBOT_TRADER_INVERT=1
 *     price in a skip range (FADEBOT_TRADER_SKIP_RANGES)  → skip (ask again with SKIP_REASK=on, else window over)
 *     price in a swap range (FADEBOT_TRADER_SWAP_RANGES)  → buy the other side instead
 */
import { inRanges, type PriceRange, rangesText, type Side } from "./fadeStrategy.ts";
import { type PickCfg, type StatsCounts, type StatsDecision, statsPick } from "./statsMode.ts";

/** One quote-age rule: quotes aged lo..hi seconds may buy only at these prices (empty = none; null = all). */
export type AgeRule = { lo: number; hi: number; allow: PriceRange[] | null };

/**
 * FADEBOT_TRADER_AGE_RULES, e.g. "0-2:none;3-5:50-99;6-10:20-29;11-15:0-19;16-20:0-19;21+:all".
 * Brackets split by ";", each "ages:prices" with ages "a-b" or "a+" (seconds) and prices "none", "all" or cent
 * ranges split by ",". Malformed brackets are ignored.
 */
export function parseAgeRules(s: string | undefined | null): AgeRule[] {
  const out: AgeRule[] = [];
  for (const part of String(s ?? "").split(";")) {
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+)|(\+))\s*:\s*(.+)$/);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[3] ? Infinity : Number(m[2]);
    const p = m[4].trim().toLowerCase();
    let allow: PriceRange[] | null;
    if (p === "all") allow = null;
    else if (p === "none") allow = [];
    else {
      allow = [];
      for (const r of p.split(",")) {
        const x = r.trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (x) allow.push({ lo: Number(x[1]) / 100, hi: Number(x[2]) / 100 });
      }
      if (!allow.length) continue;
    }
    if (hi >= lo) out.push({ lo, hi, allow });
  }
  return out;
}

export function ageRulesText(rules: AgeRule[]): string {
  return rules.map((r) =>
    `${r.lo}${r.hi === Infinity ? "+" : `–${r.hi}`} s: ${
      r.allow === null ? "all" : r.allow.length ? rangesText(r.allow) : "none"
    }`
  ).join("; ");
}

/**
 * Seconds since the quote for `side` last changed: walk back through this window's earlier recorded quotes while
 * they equal the current one. Whole seconds, like the analysis tables.
 */
export function quoteAge(
  hist: { at: number; up: number; down: number }[],
  now: { at: number; cost: number },
  side: Side,
): number {
  let t0 = now.at;
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.at >= now.at) continue;
    const c = side === "up" ? h.up : h.down;
    if (Math.abs(c - now.cost) > 1e-9) break;
    t0 = h.at;
  }
  return Math.round(now.at - t0);
}

/** Is a buy at `cost` allowed for a quote `age` seconds old? No matching rule = allowed. */
export function ageAllowed(age: number, cost: number, rules: AgeRule[]): { ok: boolean; rule: AgeRule | null } {
  const r = rules.find((x) => age >= x.lo && age <= x.hi) ?? null;
  if (!r || r.allow === null) return { ok: true, rule: r };
  return { ok: !!inRanges(cost, r.allow), rule: r };
}

export type MarketCfg = {
  /** Quote-age rules (FADEBOT_TRADER_AGE_RULES); empty = off. */
  ageRules?: AgeRule[];
  /** FADEBOT_TRADER_MIN_STALE_MOVE ($): skip when BTC moved less than this since the quote changed; 0 = off. */
  minStaleMove?: number;
  minSec: number;
  /** Seconds after the window's first call that a confirming call must come; 0 = off. */
  confirmSec?: number;
  /** Replay only: a third call ("buy") at least this many seconds after the confirming ("warm") call; 0 = off. */
  confirm2Sec?: number;
  /** The confirmation must land in this range (seconds into the window), else no trade that window. */
  confirmAt?: { lo: number; hi: number } | null;
  /** FADEBOT_TRADER_CONFIRM_AT_MODE=reask: an early confirmation doesn't count; keep asking for one in the range. */
  confirmAtReask?: boolean;
  stats: boolean;
  statsCfg: PickCfg;
  invert: boolean;
  skipJevPct: PriceRange[];
  skipRanges: PriceRange[];
  swap: boolean;
  swapRanges: PriceRange[];
};

export type MarketCall = {
  /** traderDecision's buy: Jev's side, his chance for it, its price. */
  buy: Side;
  p: number;
  cost: number;
  /** Seconds into the window. */
  at: number;
  /** Both sides' prices now. */
  upCost: number | null;
  downCost: number | null;
  /** BTC vs the window's start price in the direction of Jev's pick ($), or null. */
  dist: number | null;
  /** The live-price ban message, when the caller checked one and it hit (hybrid only). */
  liveBanned?: string;
  /** Earlier calls in this window (asks that cleared the edge after MIN_SEC), oldest first: second and Jev's side. */
  earlier?: { at: number; pick: Side }[];
  /** This window's earlier recorded quotes (all asks), oldest first, with BTC then, for the quote-age rules. */
  quoteHist?: { at: number; up: number; down: number; btc?: number | null }[];
  /** BTC now (for the stale-move filter). */
  btcNow?: number | null;
};

/** A seconds range "160-189" (or "160+" = 160–300); null when blank or malformed. */
export function parseSecRange(text: string | undefined | null): { lo: number; hi: number } | null {
  const t = String(text ?? "").trim();
  const m = t.match(/^(\d+)\s*(?:-|–|to)\s*(\d+)$/i);
  const p = t.match(/^(\d+)\s*\+$/);
  let lo: number, hi: number;
  if (m) [lo, hi] = [Number(m[1]), Number(m[2])];
  else if (p) [lo, hi] = [Number(p[1]), 300];
  else return null;
  if (lo > hi) [lo, hi] = [hi, lo];
  return { lo, hi };
}

export type ConfirmResult = { ok: true; note: string; why?: undefined } | { ok: false; why: string; note?: undefined };

/**
 * Bias and confirmation: the window's first call sets the bias (and is not bought). Each stage needs the first call
 * at least waits[i] seconds after the previous stage's call, on the bias side: with one wait (live) that call
 * confirms; with two (replay's triple confirmation) the first is "warm" and the second confirms. A call on the
 * other side becomes the new bias and the chain starts again. Once confirmed, calls on the bias side may buy.
 */
export function confirmGate(
  earlier: { at: number; pick: Side }[],
  now: { at: number; pick: Side },
  sec: number | number[],
  /** Allowed confirmation time (seconds into the window); confirmed outside it = no trade this window. */
  at?: { lo: number; hi: number } | null,
  /** With `at`: a confirmation before the range doesn't count — keep asking for one inside it (else: no trade). */
  reask = false,
): ConfirmResult {
  const waits = (Array.isArray(sec) ? sec : [sec]).filter((x) => x > 0);
  const s = (x: number) => `${Math.round(x)} s`;
  const all = [...earlier, now];
  let bias = all[0];
  let stage = 0, stageAt = bias.at, flips = 0;
  const steps: number[] = [];
  let confirmedAt: number | null = null;
  for (const c of all.slice(1)) {
    if (confirmedAt !== null) break;
    if (c.at < stageAt + waits[stage] - 1e-9) continue;
    if (c.pick === bias.pick) {
      // Re-ask mode: a final confirmation before the allowed range doesn't count; keep waiting for one inside it.
      if (reask && at && stage === waits.length - 1 && Math.round(c.at) < at.lo) continue;
      steps.push(c.at);
      stage++;
      stageAt = c.at;
      if (stage >= waits.length) confirmedAt = c.at;
    } else {
      bias = c;
      stage = 0;
      stageAt = c.at;
      steps.length = 0;
      flips++;
    }
  }
  const was = flips ? ` (bias flipped ${flips}×)` : "";
  const triple = waits.length > 1;
  if (bias === now) {
    return {
      ok: false,
      why: `${flips ? "bias flipped" : "bias set"}: Jev ${now.pick} at ${s(now.at)}; waiting for a call ${waits[0]} s later to ${
        triple ? "warm up" : "confirm"
      }`,
    };
  }
  if (confirmedAt === null) {
    let due = stageAt + waits[stage];
    if (reask && at && stage === waits.length - 1) due = Math.max(due, at.lo);
    const what = triple && stage === 1 ? `warm at ${s(stageAt)}; waiting until ${s(due)} for the buy call`
      : `waiting until ${s(due)} to ${triple ? "warm up" : "confirm"}`;
    return { ok: false, why: `bias ${bias.pick} (set at ${s(bias.at)})${was}; ${what}` };
  }
  if (at && (Math.round(confirmedAt) < at.lo || Math.round(confirmedAt) > at.hi)) {
    return {
      ok: false,
      why: `bias ${bias.pick} confirmed at ${s(confirmedAt)}, outside the ${at.lo}–${at.hi} s range (FADEBOT_TRADER_CONFIRM_AT): no trade this window`,
    };
  }
  if (now.pick !== bias.pick) {
    return { ok: false, why: `bias ${bias.pick} confirmed at ${s(confirmedAt)}, but Jev now says ${now.pick}: waiting` };
  }
  const warm = triple ? `, warm at ${s(steps[0])}` : "";
  return { ok: true, note: ` [bias ${bias.pick} at ${s(bias.at)}${was}${warm}, confirmed at ${s(confirmedAt)}]` };
}

export type MarketPick =
  | { kind: "wait"; why: string; stats: StatsDecision | null; code?: "stale" }
  | { kind: "skip"; side: Side; cost: number; range: PriceRange; why: string }
  | {
    kind: "buy";
    side: Side;
    cost: number;
    /** Buying the side Jev did NOT pick (invert, stats against, or a swap). */
    otherSide: boolean;
    /** Stats mode chose AGAINST Jev (after its invert and swap). */
    statsAgainst: boolean;
    stats: StatsDecision | null;
    note: string;
  };

/**
 * 15-minute streak block (FADEBOT_TRADER_STREAK15): `results` are the latest finished 15-minute BTC markets, newest
 * first. When the newest `n` all settled the same way, no trades. A missing result never blocks.
 */
export function streak15Block(results: (Side | null)[], n: number): { blocked: boolean; side: Side | null; run: number } {
  let run = 0;
  const first = results[0] ?? null;
  for (const r of results) {
    if (!first || r !== first) break;
    run++;
  }
  return { blocked: n > 0 && !!first && run >= n, side: first, run };
}

const opp = (s: Side): Side => (s === "up" ? "down" : "up");

/**
 * How far BTC moved (absolute $) since the quote for `side` last changed: the quote's age from this window's
 * earlier recorded quotes, then BTC recorded at that moment vs BTC now. Null when either BTC is unknown.
 */
export function staleMove(
  hist: { at: number; up: number; down: number; btc?: number | null }[],
  now: { at: number; cost: number; btc: number | null },
  side: Side,
): { age: number; move: number | null } {
  const age = quoteAge(hist, now, side);
  const t0 = now.at - age;
  const h0 = t0 >= now.at ? null : hist.find((h) => h.at >= t0 - 0.5 && h.at < now.at);
  const b0 = h0 ? h0.btc ?? null : now.btc;
  return { age, move: now.btc !== null && b0 !== null && b0 !== undefined ? Math.abs(now.btc - b0) : null };
}

export function marketPick(call: MarketCall, cfg: MarketCfg, counts: StatsCounts | null): MarketPick {
  const r = marketPickRules(call, cfg, counts);
  if (r.kind !== "buy") return r;
  let note = r.note;
  if (cfg.ageRules?.length) {
    const age = quoteAge(call.quoteHist ?? [], { at: call.at, cost: r.cost }, r.side);
    const a = ageAllowed(age, r.cost, cfg.ageRules);
    if (!a.ok) {
      return {
        kind: "wait",
        why: `${r.side} quote ${Math.round(r.cost * 100)}¢ is ${age} s old: the ${a.rule!.lo}${
          a.rule!.hi === Infinity ? "+" : `–${a.rule!.hi}`
        } s rule allows ${a.rule!.allow!.length ? rangesText(a.rule!.allow!) : "no buys"} (FADEBOT_TRADER_AGE_RULES)`,
        stats: r.stats,
      };
    }
    note += ` [quote ${age} s old]`;
  }
  // Stale-move filter (FADEBOT_TRADER_MIN_STALE_MOVE): BTC moved less than this since the side's quote last changed
  // → no buy, ask again. Unknown BTC doesn't block.
  if (cfg.minStaleMove && cfg.minStaleMove > 0) {
    const sm = staleMove(call.quoteHist ?? [], { at: call.at, cost: r.cost, btc: call.btcNow ?? null }, r.side);
    if (sm.move !== null && sm.move < cfg.minStaleMove - 1e-9) {
      return {
        kind: "wait",
        code: "stale",
        why: `${r.side} quote ${Math.round(r.cost * 100)}¢ unchanged for ${sm.age} s while BTC moved $${
          Math.round(sm.move)
        }: under $${cfg.minStaleMove} (FADEBOT_TRADER_MIN_STALE_MOVE)`,
        stats: r.stats,
      };
    }
    note += sm.move === null ? " [BTC move unknown]" : ` [BTC moved $${Math.round(sm.move)} since the quote changed]`;
  }
  return { ...r, note };
}

function marketPickRules(call: MarketCall, cfg: MarketCfg, counts: StatsCounts | null): MarketPick {
  if (call.at < cfg.minSec) {
    return { kind: "wait", why: `call at ${Math.floor(call.at)} s ignored: before ${cfg.minSec} s (FADEBOT_TRADER_MIN_SEC)`, stats: null };
  }
  let confirmNote = "";
  if (cfg.confirmSec && cfg.confirmSec > 0) {
    const waits = cfg.confirm2Sec && cfg.confirm2Sec > 0 ? [cfg.confirmSec, cfg.confirm2Sec] : [cfg.confirmSec];
    const g = confirmGate(call.earlier ?? [], { at: call.at, pick: call.buy }, waits, cfg.confirmAt, !!cfg.confirmAtReask);
    if (g.why !== undefined) return { kind: "wait", why: g.why, stats: null };
    confirmNote = g.note;
  }
  const price = (s: Side) => (s === "up" ? call.upCost : call.downCost);
  if (cfg.stats) {
    if (!counts) return { kind: "wait", why: "stats: no history", stats: null };
    const other = price(opp(call.buy));
    const sp = statsPick(
      { pick: call.buy, pct: call.p, jevCost: call.cost, otherCost: other ?? 1 - call.cost, dist: call.dist },
      counts,
      cfg.statsCfg,
    );
    if (!sp.buy) {
      return {
        kind: "wait",
        why: `stats: Jev ${Math.round(call.p * 100)}% for ${call.buy} (${sp.decision.bands}): ${sp.note}`,
        stats: sp.decision,
      };
    }
    return {
      kind: "buy",
      side: sp.side,
      cost: sp.cost,
      otherSide: sp.side !== call.buy,
      statsAgainst: sp.against,
      stats: sp.decision,
      note: sp.note + confirmNote,
    };
  }
  const jp = inRanges(Math.round(call.p * 100) / 100, cfg.skipJevPct);
  if (jp) {
    return {
      kind: "wait",
      why: `Jev ${Math.round(call.p * 100)}% for ${call.buy}: in the ${Math.round(jp.lo * 100)}–${
        Math.round(jp.hi * 100)
      }% skip range (FADEBOT_TRADER_SKIP_JEV_PCT)`,
      stats: null,
    };
  }
  if (call.liveBanned) return { kind: "wait", why: call.liveBanned, stats: null };
  let side: Side = cfg.invert ? opp(call.buy) : call.buy;
  let cost = cfg.invert ? price(side) : call.cost;
  if (cost === null || !(cost > 0 && cost < 1)) return { kind: "wait", why: `no price for ${side}`, stats: null };
  const sk = inRanges(cost, cfg.skipRanges);
  if (sk) {
    return { kind: "skip", side, cost, range: sk, why: `${side} at ${Math.round(cost * 100)}¢ is in the ${rangesText([sk])} skip range` };
  }
  let note = "";
  const sw = cfg.swap ? inRanges(cost, cfg.swapRanges) : null;
  if (sw) {
    const oc = price(opp(side));
    if (oc !== null && oc > 0 && oc < 1) {
      note = ` (${side} at ${Math.round(cost * 100)}¢ is in the ${rangesText([sw])} swap range → swapped to ${opp(side)} at ${
        Math.round(oc * 100)
      }¢)`;
      side = opp(side);
      cost = oc;
    }
  }
  return { kind: "buy", side, cost, otherSide: side !== call.buy, statsAgainst: false, stats: null, note: note + confirmNote };
}
