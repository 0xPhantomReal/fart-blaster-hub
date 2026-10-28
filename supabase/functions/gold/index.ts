// Supabase edge function: holds the Pyth and TypeSafe keys so the browser never sees them.
// Secrets: PYTH_API_KEY, TYPESAFE_API_KEY (optional: PYTH_SYMBOL, JEV_MODEL)
//
// POST { action: "history", from, to, resolution } → { candles, jev }
// POST { action: "jev", snapshot, timeframeMin, mode?: "open" | "live", slotKey? } → { choice, probGreen, confidence, usage }
// POST { action: "forecast", snapshot, timeframeMin, options: { s1…s2000 }, slotKey } → Jev tournament winner
// POST { action: "jev", mode: "forecast", snapshot, timeframeMin, options: { s1: "...", … }, slotKey } → { choice, probabilities, confidence, usage }
// POST { action: "stream" }                        → NDJSON lines { t, p } on every Pyth price tick
//   (optional secrets: PYTH_HERMES_KEY if Hermes needs a different key, PYTH_GOLD_FEED_ID)

const PYTH_BASE = "https://pyth.dourolabs.app/v1";
const PYTH_CHANNEL = "fixed_rate@200ms";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const RESOLUTIONS = new Set([1, 2, 5, 15, 30, 60, 120, 240, 360, 720]);
const MAX_SPAN_SEC = 60 * 60 * 24 * 90; // 90 days per request

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const env = (k: string) => Deno.env.get(k) ?? "";

// ── Small in-memory caches (per warm instance) so many viewers don't multiply API calls ──
const historyCache = new Map<string, { at: number; body: unknown }>();
const jevCache = new Map<string, { at: number; body: unknown }>();
function cached<T>(map: Map<string, { at: number; body: unknown }>, key: string, ttlMs: number): T | undefined {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body as T;
  if (map.size > 500) map.clear();
  return undefined;
}

// ── Pyth ───────────────────────────────────────────────────────────────

let goldSymbol = env("PYTH_SYMBOL");

async function resolveSymbol(): Promise<string> {
  if (goldSymbol) return goldSymbol;
  try {
    const res = await fetch(`${PYTH_BASE}/symbols?query=XAU&asset_type=metal`);
    const list = await res.json();
    const rows: Array<Record<string, string>> = Array.isArray(list) ? list : (list.symbols ?? []);
    const names = rows.map((r) => r.symbol ?? r.name ?? "").filter(Boolean);
    goldSymbol = names.find((n) => /XAU\/?USD$/i.test(n)) ?? names.find((n) => /XAU/i.test(n)) ?? "Metal.XAU/USD";
  } catch {
    goldSymbol = "Metal.XAU/USD";
  }
  return goldSymbol;
}

async function history(from: number, to: number, resolution: number) {
  // Round `to` down to 5s so near-simultaneous viewers share one upstream call.
  const toR = Math.floor(to / 5) * 5;
  const key = `${from}:${toR}:${resolution}`;
  const hit = cached<unknown>(historyCache, key, 4000);
  if (hit) return hit;

  const symbol = await resolveSymbol();
  const q = new URLSearchParams({ symbol, from: String(from), to: String(toR), resolution: String(resolution) });
  const res = await fetch(`${PYTH_BASE}/${PYTH_CHANNEL}/history?${q}`, {
    headers: { Authorization: `Bearer ${env("PYTH_API_KEY")}` },
  });
  if (!res.ok) throw new Error(`Pyth ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const r = await res.json();
  if (r.s === "no_data") return { candles: [], jev: !!env("TYPESAFE_API_KEY") };
  if (r.s !== "ok") throw new Error(`Pyth: ${r.errmsg ?? r.s}`);
  const candles = (r.t as number[]).map((t, i) => ({ time: t, open: r.o[i], high: r.h[i], low: r.l[i], close: r.c[i] }));
  const body = { candles, jev: !!env("TYPESAFE_API_KEY") };
  historyCache.set(key, { at: Date.now(), body });
  return body;
}

// ── Live ticks (Pyth Hermes SSE → compact NDJSON for the browser) ─────

const HERMES_BASE = () => env("PYTH_HERMES_BASE") || "https://hermes.pyth.network";
const hermesKey = () => env("PYTH_HERMES_KEY") || env("PYTH_API_KEY");
let goldFeedId = env("PYTH_GOLD_FEED_ID");

async function resolveFeedId(): Promise<string> {
  if (goldFeedId) return goldFeedId;
  for (const assetType of ["metal", "metals"]) {
    const res = await fetch(`${HERMES_BASE()}/v2/price_feeds?query=XAU&asset_type=${assetType}`, {
      headers: { Authorization: `Bearer ${hermesKey()}` },
    });
    if (!res.ok) continue;
    const rows: Array<{ id: string; attributes?: Record<string, string> }> = await res.json();
    const isGoldUsd = (r: { attributes?: Record<string, string> }) =>
      Object.values(r.attributes ?? {}).some((v) => /XAU\/?USD$/i.test(v));
    const pick = rows.find(isGoldUsd);
    if (pick) {
      goldFeedId = pick.id.startsWith("0x") ? pick.id : `0x${pick.id}`;
      return goldFeedId;
    }
  }
  throw new Error("could not find the XAU/USD feed on Hermes (set PYTH_GOLD_FEED_ID)");
}

// Edge functions have a wall-clock limit, so each stream ends after ~2 minutes and the page reconnects.
const STREAM_MS = 120_000;

async function tickStream(): Promise<Response> {
  const id = await resolveFeedId();
  const upstream = await fetch(`${HERMES_BASE()}/v2/updates/price/stream?ids[]=${id}&parsed=true&encoding=hex`, {
    headers: { Authorization: `Bearer ${hermesKey()}`, Accept: "text/event-stream" },
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Hermes ${upstream.status}: ${(await upstream.text()).slice(0, 160)}`);
  }
  const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
  const enc = new TextEncoder();
  let buf = "";

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const timer = setTimeout(() => reader.cancel().catch(() => {}), STREAM_MS);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const msg = JSON.parse(line.slice(5));
              for (const p of msg.parsed ?? []) {
                const pr = p.price;
                const expo = Number(pr.expo);
                const price = expo < 0 ? Number(pr.price) / 10 ** -expo : Number(pr.price) * 10 ** expo;
                if (Number.isFinite(price)) {
                  controller.enqueue(enc.encode(JSON.stringify({ t: pr.publish_time, p: price }) + "\n"));
                }
              }
            } catch {
              // skip partial or non-price lines
            }
          }
        }
      } finally {
        clearTimeout(timer);
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
  return new Response(body, { headers: { ...cors, "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
}

// ── Jev ────────────────────────────────────────────────────────────────

type JevMode = "open" | "live" | "forecast";
const inflight = new Map<string, Promise<unknown>>();

const QUESTIONS: Record<"open" | "live", { instructions: string; green: string; red: string }> = {
  // Asked once per candle, before it starts.
  open: {
    instructions:
      "Will the very NEXT 15-minute candle close above or below its open? Focus on the last 1-3 candles: " +
      "exhaustion after outsized candles, rejection wicks, closes near highs or lows, and nearby levels. " +
      "Longer-term trend is background only.",
    green: "Buyers keep control: momentum or trend continues, or price bounces off nearby support",
    red: "Sellers take control: an outsized move gets faded, price rejects nearby resistance, or trend rolls over",
  },
  // Asked every ~10s while a candle is forming, with only the fresh data.
  live: {
    instructions:
      "The 15-minute candle in forming_candle is still open. Will it CLOSE above or below its open price? " +
      "Weigh whether the move so far HOLDS or REVERTS before the close: compare move_so_far with typical_move_left " +
      "(how far price can still travel in the time left), use historically_holds_pct (how much of a move at this " +
      "point usually survives), and how far price has already pulled back from its high or bounced off its low. " +
      "Then account for the last 10 seconds and nearby levels.",
    green: "It finishes above its open: an up move holds, or a down move reverts back above the open",
    red: "It finishes below its open: a down move holds, or an up move reverts back below the open",
  },
};

const FORECAST_INSTRUCTIONS =
  "Each option is a possible path for the NEXT 5 fifteen-minute candles of gold, taken from moments in gold's own " +
  "history that looked like now. Per candle: G/R = green/red, signed body, ^ upper wick, v lower wick, all in ATR " +
  "units. Given the market state, which path is the most likely to happen?";

async function jev(
  snapshot: Record<string, unknown>,
  timeframeMin: number,
  mode: JevMode,
  slotKey: string | null,
  options: Record<string, string> | null,
) {
  // Live and forecast calls are keyed by time slot, so every viewer shares one TypeSafe call.
  const key = slotKey && mode !== "open" ? `${mode}:${slotKey}` : `open:${JSON.stringify(snapshot)}`;
  const hit = cached<unknown>(jevCache, key, mode === "live" ? 20_000 : 10 * 60 * 1000);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const question =
    mode === "forecast" && options
      ? { type: "choice", instructions: FORECAST_INSTRUCTIONS, criteria: options }
      : (() => {
          const q = QUESTIONS[mode === "live" ? "live" : "open"];
          return { type: "choice", instructions: q.instructions, criteria: { green: q.green, red: q.red } };
        })();
  const call = (async () => {
    const res = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("TYPESAFE_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env("JEV_MODEL") || "jev-latest",
        state: { instrument: `Gold (XAU/USD), ${timeframeMin}-minute candles`, ...snapshot },
        questions: { next_candle: question },
      }),
    });
    if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const r = await res.json();
    const a = r?.answers?.next_candle;
    if (mode === "forecast") {
      if (!a || typeof a.choice !== "string" || typeof a.probabilities !== "object" || typeof a.confidence !== "number") {
        throw new Error("unexpected TypeSafe response shape");
      }
      const body = { choice: a.choice, probabilities: a.probabilities, confidence: a.confidence, usage: r.usage ?? null };
      jevCache.set(key, { at: Date.now(), body });
      return body;
    }
    if (!a || (a.choice !== "green" && a.choice !== "red") || typeof a.confidence !== "number" || typeof a.probabilities?.green !== "number") {
      throw new Error("unexpected TypeSafe response shape");
    }
    const body = { choice: a.choice, probGreen: a.probabilities.green, confidence: a.confidence, usage: r.usage ?? null };
    jevCache.set(key, { at: Date.now(), body });
    return body;
  })();
  inflight.set(key, call);
  try {
    return await call;
  } finally {
    inflight.delete(key);
  }
}

// ── Forecast tournament: up to 2,000 paths ─────────────────────────────
// Jev takes at most 255 options per choice question and ~32k tokens per request, so the paths are split
// into batches of 250 asked in parallel; each batch's top picks go to a final round, and Jev picks the winner.

const SHARD = 250;
const FINALISTS_PER_SHARD = 6;

type ChoiceAnswer = { choice: string; probabilities: Record<string, number>; confidence: number };

async function askChoice(state: Record<string, unknown>, instructions: string, criteria: Record<string, string>) {
  const res = await fetch(TYPESAFE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("TYPESAFE_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env("JEV_MODEL") || "jev-latest",
      state,
      questions: { pick: { type: "choice", instructions, criteria } },
    }),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const r = await res.json();
  const a = r?.answers?.pick as ChoiceAnswer | undefined;
  if (!a || typeof a.choice !== "string" || typeof a.probabilities !== "object") throw new Error("unexpected TypeSafe response shape");
  return { answer: a, tokens: Number(r?.usage?.input_tokens ?? 0) };
}

const PATHS_HOW_TO_READ =
  "Each option is a possible path for the next 5 fifteen-minute candles of gold (candle 1 is the one forming now), " +
  "taken from moments in gold's own history that looked like now. Per candle: G/R = green/red, signed body, " +
  "^ upper wick, v lower wick, all in ATR units. Options are listed most-similar-to-now first.";

async function forecastTournament(snapshot: Record<string, unknown>, timeframeMin: number, options: Record<string, string>) {
  const state = { instrument: `Gold (XAU/USD), ${timeframeMin}-minute candles`, ...snapshot };
  const entries = Object.entries(options);
  const shards: Record<string, string>[] = [];
  for (let i = 0; i < entries.length; i += SHARD) shards.push(Object.fromEntries(entries.slice(i, i + SHARD)));

  const round1 = await Promise.all(
    shards.map((criteria) =>
      askChoice(state, `${PATHS_HOW_TO_READ} Which path is the most likely to happen?`, criteria),
    ),
  );
  let tokens = round1.reduce((a, r) => a + r.tokens, 0);
  const shardP: Record<string, number> = {};
  const finalists: Record<string, string> = {};
  for (const { answer } of round1) {
    const top = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, FINALISTS_PER_SHARD);
    for (const [id, p] of top) {
      if (options[id]) {
        finalists[id] = options[id];
        shardP[id] = p;
      }
    }
  }

  let final: ChoiceAnswer;
  if (shards.length === 1) {
    final = round1[0].answer;
  } else {
    const r = await askChoice(
      state,
      `${PATHS_HOW_TO_READ} These finalists were the strongest picks from ${entries.length} paths. Which is the most likely to happen?`,
      finalists,
    );
    tokens += r.tokens;
    final = r.answer;
  }
  const ranked = Object.entries(final.probabilities)
    .filter(([id]) => options[id])
    .sort((a, b) => b[1] - a[1]);
  return {
    winner: ranked[0]?.[0] ?? final.choice,
    pFinal: ranked[0]?.[1] ?? null,
    top: ranked.slice(0, 5).map(([id, p]) => ({ id, p })),
    finalists: shards.length === 1 ? entries.length : Object.keys(finalists).length,
    paths: entries.length,
    calls: round1.length + (shards.length === 1 ? 0 : 1),
    tokens,
  };
}

// ── Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  try {
    if (body.action === "history") {
      if (!env("PYTH_API_KEY")) return json({ error: "PYTH_API_KEY secret is not set" }, 503);
      const { from, to, resolution } = body as { from: unknown; to: unknown; resolution: unknown };
      if (typeof from !== "number" || typeof to !== "number" || typeof resolution !== "number") {
        return json({ error: "from, to and resolution must be numbers" }, 400);
      }
      if (!RESOLUTIONS.has(resolution)) return json({ error: "unsupported resolution" }, 400);
      if (to <= from || to - from > MAX_SPAN_SEC) return json({ error: "bad time range" }, 400);
      return json(await history(Math.floor(from), Math.floor(to), resolution));
    }

    if (body.action === "version") {
      // Lets the page check which backend is deployed (older versions answer "unknown action").
      return json({ version: 6, features: ["stream", "jev-live", "jev-forecast", "forecast-tournament"], jev: !!env("TYPESAFE_API_KEY") });
    }

    if (body.action === "stream") {
      if (!hermesKey()) return json({ error: "PYTH_API_KEY secret is not set" }, 503);
      return await tickStream();
    }

    if (body.action === "forecast") {
      if (!env("TYPESAFE_API_KEY")) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503);
      const { snapshot, timeframeMin, options, slotKey } = body as Record<string, unknown>;
      if (typeof snapshot !== "object" || snapshot === null || JSON.stringify(snapshot).length > 8000) {
        return json({ error: "bad snapshot" }, 400);
      }
      if (typeof timeframeMin !== "number" || !RESOLUTIONS.has(timeframeMin)) return json({ error: "bad timeframe" }, 400);
      const entries = options && typeof options === "object" ? Object.entries(options as Record<string, unknown>) : [];
      const valid =
        entries.length >= 2 &&
        entries.length <= 2000 &&
        entries.every(([k, v]) => /^s\d{1,4}$/.test(k) && typeof v === "string" && v.length <= 120);
      if (!valid) return json({ error: "bad forecast options" }, 400);
      if (typeof slotKey !== "string" || slotKey.length > 64) return json({ error: "bad slotKey" }, 400);

      // One tournament per minute, shared by every viewer.
      const key = `tournament:${slotKey}`;
      const hit = cached<unknown>(jevCache, key, 90_000);
      if (hit) return json(hit);
      let run = inflight.get(key);
      if (!run) {
        run = forecastTournament(snapshot as Record<string, unknown>, timeframeMin, options as Record<string, string>).then((r) => {
          jevCache.set(key, { at: Date.now(), body: r });
          return r;
        });
        inflight.set(key, run);
        run.finally(() => inflight.delete(key)).catch(() => {});
      }
      return json(await run);
    }

    if (body.action === "jev") {
      if (!env("TYPESAFE_API_KEY")) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503);
      const { snapshot, timeframeMin } = body as { snapshot: unknown; timeframeMin: unknown };
      if (typeof snapshot !== "object" || snapshot === null || JSON.stringify(snapshot).length > 8000) {
        return json({ error: "bad snapshot" }, 400);
      }
      if (typeof timeframeMin !== "number" || !RESOLUTIONS.has(timeframeMin)) return json({ error: "bad timeframe" }, 400);
      const mode: JevMode = body.mode === "live" ? "live" : body.mode === "forecast" ? "forecast" : "open";
      const slotKey = typeof body.slotKey === "string" && body.slotKey.length <= 64 ? body.slotKey : null;
      let options: Record<string, string> | null = null;
      if (mode === "forecast") {
        // Up to 255 options per Jev choice question; keep each short and the total well inside one request.
        const o = body.options as Record<string, unknown> | undefined;
        const entries = o && typeof o === "object" ? Object.entries(o) : [];
        const valid =
          entries.length >= 2 &&
          entries.length <= 255 &&
          entries.every(([k, v]) => /^s\d{1,3}$/.test(k) && typeof v === "string" && v.length <= 200) &&
          JSON.stringify(o).length <= 60_000;
        if (!valid) return json({ error: "bad forecast options" }, 400);
        options = o as Record<string, string>;
      }
      return json(await jev(snapshot as Record<string, unknown>, timeframeMin, mode, slotKey, options));
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 502);
  }
});
