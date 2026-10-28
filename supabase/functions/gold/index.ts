// Supabase edge function: holds the Pyth and TypeSafe keys so the browser never sees them.
// Secrets: PYTH_API_KEY, TYPESAFE_API_KEY (optional: PYTH_SYMBOL, JEV_MODEL)
//
// POST { action: "history", from, to, resolution } → { candles, jev }
// POST { action: "jev", snapshot, timeframeMin, mode?: "open" | "live", slotKey? } → { choice, probGreen, confidence, usage }
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

type JevMode = "open" | "live";
const inflight = new Map<string, Promise<unknown>>();

const QUESTIONS: Record<JevMode, { instructions: string; green: string; red: string }> = {
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
      "Judge the move so far, what happened in the last 10 seconds, time left, and nearby levels.",
    green: "It finishes above its open: buyers hold or regain control before the close",
    red: "It finishes below its open: sellers hold or take control before the close",
  },
};

async function jev(snapshot: Record<string, unknown>, timeframeMin: number, mode: JevMode, slotKey: string | null) {
  // Live calls: one TypeSafe call per 10-second slot, shared by every viewer.
  const key = mode === "live" && slotKey ? `live:${slotKey}` : `open:${JSON.stringify(snapshot)}`;
  const hit = cached<unknown>(jevCache, key, mode === "live" ? 20_000 : 10 * 60 * 1000);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const q = QUESTIONS[mode];
  const call = (async () => {
    const res = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("TYPESAFE_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env("JEV_MODEL") || "jev-latest",
        state: { instrument: `Gold (XAU/USD), ${timeframeMin}-minute candles`, ...snapshot },
        questions: {
          next_candle: { type: "choice", instructions: q.instructions, criteria: { green: q.green, red: q.red } },
        },
      }),
    });
    if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const r = await res.json();
    const a = r?.answers?.next_candle;
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
      return json({ version: 4, features: ["stream", "jev-live"], jev: !!env("TYPESAFE_API_KEY") });
    }

    if (body.action === "stream") {
      if (!hermesKey()) return json({ error: "PYTH_API_KEY secret is not set" }, 503);
      return await tickStream();
    }

    if (body.action === "jev") {
      if (!env("TYPESAFE_API_KEY")) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503);
      const { snapshot, timeframeMin } = body as { snapshot: unknown; timeframeMin: unknown };
      if (typeof snapshot !== "object" || snapshot === null || JSON.stringify(snapshot).length > 8000) {
        return json({ error: "bad snapshot" }, 400);
      }
      if (typeof timeframeMin !== "number" || !RESOLUTIONS.has(timeframeMin)) return json({ error: "bad timeframe" }, 400);
      const mode: JevMode = body.mode === "live" ? "live" : "open";
      const slotKey = typeof body.slotKey === "string" && body.slotKey.length <= 64 ? body.slotKey : null;
      return json(await jev(snapshot as Record<string, unknown>, timeframeMin, mode, slotKey));
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 502);
  }
});
