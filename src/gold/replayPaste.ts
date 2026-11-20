/**
 * Paste settings into the /bot replay form, and the reference other agents can use to send them.
 *
 * Accepts, in any order:
 *   - secret lines exactly as the bot uses them:  FADEBOT_TRADER_EDGE=20
 *   - short names:                                 EDGE=20   or   STATS_MIN_EDGE: 25
 *   - the form's own keys:                         edge=20   or   statsMinEdge: 25
 *   - JSON:                                        {"edge": 20, "statsMinEdge": 25}
 * One setting per line ("=" or ":" between name and value; the first one counts, so AGE_RULES=0-2:none;… works).
 * Lines starting with # or // are ignored. Settings not given keep their current value.
 */

export type PasteKind = "num" | "range" | "onoff" | "choice" | "text";

export type PasteSpec = {
  /** The replay form's key. */
  key: string;
  /** The live secret, or null for replay-only settings. */
  secret: string | null;
  kind: PasteKind;
  unit: string;
  example: string;
  meaning: string;
};

/** Every setting, in the standard order (the order the form shows them). */
export const PASTE_SPEC: PasteSpec[] = [
  { key: "edge", secret: "FADEBOT_TRADER_EDGE", kind: "num", unit: "points", example: "20", meaning: "Jev's % must beat his side's price by this many points" },
  { key: "minSec", secret: "FADEBOT_TRADER_MIN_SEC", kind: "num", unit: "seconds", example: "30", meaning: "ignore calls before this second of the window" },
  { key: "confirmSec", secret: "FADEBOT_TRADER_CONFIRM_SEC", kind: "num", unit: "seconds", example: "120", meaning: "bias + confirmation: confirming call at least this long after the first (0 = off)" },
  { key: "confirm2Sec", secret: null, kind: "num", unit: "seconds", example: "0", meaning: "REPLAY ONLY: triple confirmation, buy call this long after the warm call (0 = off)" },
  { key: "confirmAt", secret: "FADEBOT_TRADER_CONFIRM_AT", kind: "range", unit: "seconds range", example: "160-189", meaning: "confirmation must land in this second range (blank = any time)" },
  { key: "confirmAtMode", secret: "FADEBOT_TRADER_CONFIRM_AT_MODE", kind: "choice", unit: "reask | skip", example: "reask", meaning: "confirmed too early: ask again (reask) or skip the window (skip)" },
  { key: "ageRules", secret: "FADEBOT_TRADER_AGE_RULES", kind: "text", unit: "age:prices;…", example: "0-2:none;3-5:50-99;21+:all", meaning: "quote-age rules (blank = off)" },
  { key: "streak15", secret: "FADEBOT_TRADER_STREAK15", kind: "num", unit: "count", example: "0", meaning: "no trades after this many same 15m results in a row (0 = off)" },
  { key: "minStaleMove", secret: "FADEBOT_TRADER_MIN_STALE_MOVE", kind: "num", unit: "$", example: "15", meaning: "skip a buy (ask again) when BTC moved less than this since the side's quote last changed (0 = off)" },
  { key: "skipJevPct", secret: "FADEBOT_TRADER_SKIP_JEV_PCT", kind: "range", unit: "% ranges", example: "50-55,61-70", meaning: "stats off: skip calls with Jev's % in these ranges" },
  { key: "invert", secret: "FADEBOT_TRADER_INVERT", kind: "onoff", unit: "on/off", example: "off", meaning: "stats off: buy the side Jev didn't pick" },
  { key: "ban", secret: "FADEBOT_TRADER_BAN", kind: "range", unit: "¢ range", example: "51-99", meaning: "stats off: no buys when Jev's side costs this (blank = off; BAN=on + BAN_MIN/BAN_MAX also work)" },
  { key: "skipRanges", secret: "FADEBOT_TRADER_SKIP_RANGES", kind: "range", unit: "¢ ranges", example: "49-62", meaning: "stats off: skip buys at these prices" },
  { key: "skipReask", secret: "FADEBOT_TRADER_SKIP_REASK", kind: "onoff", unit: "on/off", example: "on", meaning: "stats off: after a skip, ask again (on) or wait for the next window (off)" },
  { key: "swapRanges", secret: "FADEBOT_TRADER_SWAP_RANGES", kind: "range", unit: "¢ ranges", example: "60-99", meaning: "stats off: buys at these prices take the other side (blank = no swap; SWAP=off also clears)" },
  { key: "stats", secret: "FADEBOT_TRADER_STATS", kind: "onoff", unit: "on/off", example: "on", meaning: "stats mode" },
  { key: "statsMinEdge", secret: "FADEBOT_TRADER_STATS_MIN_EDGE", kind: "num", unit: "¢ per $1", example: "5", meaning: "stats: buy only if the best choice makes at least this" },
  { key: "statsInvert", secret: "FADEBOT_TRADER_STATS_INVERT", kind: "onoff", unit: "on/off", example: "off", meaning: "stats: flip stats mode's choice" },
  { key: "statsSwapAbove", secret: "FADEBOT_TRADER_STATS_SWAP_ABOVE", kind: "num", unit: "¢", example: "0", meaning: "stats: buys over this price take the other side (0 = off)" },
  { key: "statsSwapRanges", secret: "FADEBOT_TRADER_STATS_SWAP_RANGES", kind: "range", unit: "¢ ranges", example: "60-80", meaning: "stats: buys at these prices take the other side" },
  { key: "statsSkipRanges", secret: "FADEBOT_TRADER_STATS_SKIP_RANGES", kind: "range", unit: "¢ ranges", example: "0-9,30-39", meaning: "stats: skip buys at these prices (after any swap)" },
  { key: "statsMaxAgainst", secret: "FADEBOT_TRADER_STATS_MAX_AGAINST", kind: "num", unit: "$", example: "150", meaning: "stats: skip when BTC is this far past the start against the side bought (0 = off)" },
  { key: "statsMinN", secret: "FADEBOT_TRADER_STATS_MIN_N", kind: "num", unit: "count", example: "15", meaning: "stats: minimum past calls in a bucket" },
  { key: "statsSlip", secret: "FADEBOT_TRADER_STATS_SLIP", kind: "num", unit: "¢", example: "9", meaning: "stats: assumed fill gap when scoring" },
  { key: "statsCandles", secret: "FADEBOT_TRADER_STATS_CANDLES", kind: "num", unit: "windows", example: "288", meaning: "stats: history length (288 = 24 h)" },
  { key: "maxFill", secret: null, kind: "num", unit: "¢", example: "0", meaning: "REPLAY ONLY: buys that would fill above this (quote + gap) don't fill; asks again (0 = off)" },
  { key: "tpPct", secret: null, kind: "num", unit: "% of price paid", example: "0", meaning: "REPLAY ONLY: take profit (0 = off)" },
  { key: "slPct", secret: null, kind: "num", unit: "% of price paid", example: "0", meaning: "REPLAY ONLY: stop loss (0 = off)" },
  { key: "maxEntries", secret: "FADEBOT_TRADER_MAX_ENTRIES", kind: "num", unit: "count", example: "1", meaning: "buys per window (only matters after a sell)" },
  { key: "sizing", secret: null, kind: "choice", unit: "pct | martingale | fibonacci", example: "pct", meaning: "REPLAY ONLY: how bets are sized (pct = bet % of balance, the live rule)" },
  { key: "betPct", secret: "FADEBOT_TRADER_BET_PCT", kind: "num", unit: "% of balance", example: "7", meaning: "bet size" },
  { key: "baseBet", secret: null, kind: "num", unit: "$", example: "20", meaning: "REPLAY ONLY: martingale/fibonacci starting bet (blank = bet % of the start)" },
  { key: "mgMult", secret: null, kind: "num", unit: "×", example: "2", meaning: "REPLAY ONLY: martingale multiplier after a loss" },
  { key: "resetAfter", secret: null, kind: "num", unit: "count", example: "0", meaning: "REPLAY ONLY: back to the base bet after this many losses in a row (0 = never)" },
  { key: "dailyLoss", secret: "FADEBOT_TRADER_DAILY_LOSS", kind: "num", unit: "$", example: "900", meaning: "stop for the day after losing this much" },
];

/** Replay controls (not settings of the bot). */
export const PASTE_CONTROLS = [
  { key: "days", example: "7", meaning: "days to replay (1-7)" },
  { key: "gap", example: "10", meaning: "¢ paid over the quote on each fill (0-30)" },
  { key: "start", example: "800", meaning: "starting balance ($)" },
] as const;

const ALIASES: Record<string, string> = {
  takeprofit: "tpPct",
  tp: "tpPct",
  stoploss: "slPct",
  sl: "slPct",
  warmsec: "confirm2Sec",
  startbalance: "start",
  balance: "start",
};

const norm = (s: string) => s.replace(/^FADEBOT_TRADER_/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();

const byNorm = new Map<string, string>();
for (const f of PASTE_SPEC) {
  byNorm.set(norm(f.key), f.key);
  if (f.secret) byNorm.set(norm(f.secret), f.key);
}
for (const c of PASTE_CONTROLS) byNorm.set(c.key, c.key);
for (const [a, k] of Object.entries(ALIASES)) byNorm.set(a, k);

export type PasteResult = {
  form: Record<string, string>;
  controls: { days?: number; gap?: number; start?: number };
  applied: string[];
  ignored: string[];
};

const blank = (v: string) => /^(\(delete\)|delete|none|off|-|)$/i.test(v.trim());
const onOff = (v: string) =>
  /^(1|on|true|yes)$/i.test(v.trim()) ? "on" : /^(0|off|false|no)$/i.test(v.trim()) ? "off" : null;
const firstNum = (v: string) => {
  const m = v.match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : null;
};
const cleanRange = (v: string) => v.replace(/[\s¢]/g, "").replace(/(\d)c\b/gi, "$1").replace(/(\d)s\b/gi, "$1");

/** Turn pasted text into form values on top of `base` (settings not mentioned keep their value). */
export function parsePaste(text: string, base: Record<string, string>): PasteResult {
  const pairs: [string, string][] = [];
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(t) as Record<string, unknown>)) {
        pairs.push([k, typeof v === "boolean" ? (v ? "on" : "off") : String(v ?? "")]);
      }
    } catch {
      // not JSON after all: fall through to lines
    }
  }
  if (!pairs.length) {
    for (const raw of t.split(/\r?\n/)) {
      const line = raw.trim().replace(/^[-*•]\s+/, "").replace(/^`|`$/g, "");
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const eq = line.indexOf("="), co = line.indexOf(":");
      const i = eq < 0 ? co : co < 0 ? eq : Math.min(eq, co);
      if (i <= 0) continue;
      const key = line.slice(0, i).trim().replace(/^["'`]+|["'`]+$/g, "");
      pairs.push([key, line.slice(i + 1).replace(/^[\s"'`]+|[\s"'`,]+$/g, "")]);
    }
  }
  const form = { ...base };
  const controls: PasteResult["controls"] = {};
  const applied: string[] = [];
  const ignored: string[] = [];
  let ban: string | null = null, banMin: string | null = null, banMax: string | null = null, swapOff = false;
  for (const [k0, v] of pairs) {
    const n = norm(k0);
    if (n === "order") continue; // the replay is market buys only
    if (n === "banmin") {
      banMin = firstNum(v);
      continue;
    }
    if (n === "banmax") {
      banMax = firstNum(v);
      continue;
    }
    if (n === "swap") {
      const o = onOff(v);
      if (o === "off") swapOff = true;
      if (o) applied.push(`swap = ${o}`);
      else ignored.push(`${k0}=${v}`);
      continue;
    }
    const key = byNorm.get(n);
    if (!key) {
      ignored.push(`${k0}=${v}`);
      continue;
    }
    if (key === "days" || key === "gap" || key === "start") {
      const x = Number(firstNum(v));
      if (!Number.isFinite(x)) {
        ignored.push(`${k0}=${v}`);
        continue;
      }
      controls[key] = key === "days" ? Math.min(7, Math.max(1, Math.round(x))) : key === "gap"
        ? Math.min(30, Math.max(0, x))
        : Math.max(1, x);
      applied.push(`${key} = ${controls[key]}`);
      continue;
    }
    if (key === "ban") {
      ban = v;
      continue;
    }
    const spec = PASTE_SPEC.find((f) => f.key === key)!;
    let val: string | null;
    if (spec.kind === "onoff") val = onOff(v);
    else if (spec.kind === "choice") {
      val = key === "sizing"
        ? /mart/i.test(v) ? "martingale" : /fib/i.test(v) ? "fibonacci" : /pct|%|percent|balance/i.test(v) ? "pct" : null
        : /reask|again/i.test(v) ? "reask" : /skip/i.test(v) ? "skip" : null;
    }
    else if (spec.kind === "num") val = blank(v) ? (key === "dailyLoss" ? "" : "0") : firstNum(v);
    else if (spec.kind === "range") val = blank(v) ? "" : cleanRange(v);
    else val = blank(v) ? "" : v.replace(/\s/g, "");
    if (val === null) {
      ignored.push(`${k0}=${v}`);
      continue;
    }
    form[key] = val;
    applied.push(`${key} = ${val === "" ? "(blank)" : val}`);
  }
  if (ban !== null || banMin !== null || banMax !== null) {
    let b: string | null = null;
    const o = ban === null ? null : onOff(ban);
    if (o === "off" || (ban !== null && blank(ban) && o !== "on")) b = "";
    else if (ban !== null && /\d/.test(ban)) b = cleanRange(ban);
    else if (o === "on" || banMin !== null || banMax !== null) b = `${banMin ?? "45"}-${banMax ?? "60"}`;
    if (b !== null) {
      form.ban = b;
      applied.push(`ban = ${b === "" ? "(blank)" : b}`);
    }
  }
  if (swapOff) form.swapRanges = "";
  return { form, controls, applied, ignored };
}

/** The current settings in paste format (standard order), e.g. to send to another agent. */
export function toPaste(form: Record<string, string>, controls: { days: number; gap: number; start?: number }): string {
  const lines = PASTE_SPEC.map((f) => `${f.secret ?? f.key.replace(/([A-Z])/g, "_$1").toUpperCase()}=${form[f.key] ?? ""}`);
  lines.push(`DAYS=${controls.days}`, `GAP=${controls.gap}`);
  if (controls.start) lines.push(`START=${controls.start}`);
  return lines.join("\n");
}

/** The full format reference, for other agents. */
export function pasteReference(): string {
  const rows = PASTE_SPEC.map((f) =>
    `${f.secret ?? f.key.replace(/([A-Z])/g, "_$1").toUpperCase()}=${f.example}   [${f.unit}] ${f.meaning}`
  );
  return [
    "FADEBOT REPLAY: SETTINGS PASTE FORMAT",
    "One setting per line: NAME=VALUE (NAME: VALUE also works). Any order is fine; the list below is the",
    "standard order. Lines starting with # are ignored. Settings you leave out keep their current value.",
    "NAME can be the full secret (FADEBOT_TRADER_EDGE), the short name (EDGE) or the form key (edge).",
    'JSON also works: {"edge": 20, "statsMinEdge": 5, "confirmAt": "160-189"}',
    "",
    "Units: edge in points; prices in cents; ranges as lo-hi, several separated by commas (30-39,60-80);",
    "times in seconds; money in dollars. on/off settings also take 1/0 or true/false.",
    "Blank, none, off or (delete) clears a range or text setting. Ranges are inclusive (30-39 = 30¢ to 39¢).",
    "Settings marked REPLAY ONLY have no live secret.",
    "Every setting, in the standard order (NAME=example   [unit] meaning):",
    ...rows,
    "",
    "Replay controls (not bot settings):",
    ...PASTE_CONTROLS.map((c) => `${c.key.toUpperCase()}=${c.example}   ${c.meaning}`),
    "",
    "Also accepted: FADEBOT_TRADER_BAN=on with BAN_MIN / BAN_MAX (cents), FADEBOT_TRADER_SWAP=off (clears swap ranges),",
    "FADEBOT_TRADER_ORDER (ignored: the replay is market buys only).",
    "",
    "Example:",
    "EDGE=20",
    "MIN_SEC=30",
    "CONFIRM_SEC=120",
    "CONFIRM_AT=160-189",
    "CONFIRM_AT_MODE=reask",
    "STATS=on",
    "STATS_MIN_EDGE=5",
    "STATS_SKIP_RANGES=0-9,30-39",
    "STATS_MAX_AGAINST=150",
    "BET_PCT=7",
    "DAYS=7",
    "GAP=10",
  ].join("\n");
}
