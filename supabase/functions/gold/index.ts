// Supabase edge function for the /gold page. Holds the Pyth and TypeSafe keys so the browser never sees them.
// Secrets: PYTH_API_KEY, TYPESAFE_API_KEY (optional: PYTH_SYMBOL, PYTH_HERMES_KEY, PYTH_GOLD_FEED_ID, JEV_MODEL)
//
// POST { action: "history", from, to, resolution } → { candles, jev }
// POST { action: "stream" }                        → NDJSON lines { t, p } on every Pyth price tick
// POST { action: "check", snapshot, forTime }       → { pGreen, support, confidence }  (Jev: own call + fact-check)
// POST { action: "flip", state, slotKey }           → { pFlip, confidence }  (Jev: will the forming candle flip?)
// POST { action: "tickcheck" }                    → which Pyth host/feed works for live ticks, or exactly why not
// POST { action: "version" }                        → { version, features }

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
  if (map.size > 2000) map.clear();
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

const hermesKey = () => env("PYTH_HERMES_KEY") || env("PYTH_API_KEY");
// Pyth documents both hosts as serving the same Hermes API with the same key; try each.
const HERMES_HOSTS = () =>
  [...new Set([env("PYTH_HERMES_BASE"), "https://hermes.pyth.network", "https://pyth.dourolabs.app/hermes"].filter(Boolean))];
// Used only if the lookup fails; PYTH_GOLD_FEED_ID overrides it.
const KNOWN_XAU_USD = "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2";
let goldFeed: { id: string; source: "secret" | "lookup" | "fallback" } | null = env("PYTH_GOLD_FEED_ID")
  ? { id: env("PYTH_GOLD_FEED_ID"), source: "secret" }
  : null;

async function resolveFeedId(host: string): Promise<{ id: string; source: "secret" | "lookup" | "fallback" }> {
  if (goldFeed && goldFeed.source !== "fallback") return goldFeed;
  for (const q of ["query=XAU&asset_type=metal", "query=XAU&asset_type=metals", "query=XAU"]) {
    try {
      const res = await fetch(`${host}/v2/price_feeds?${q}`, { headers: { Authorization: `Bearer ${hermesKey()}` } });
      if (!res.ok) continue;
      const rows: Array<{ id: string; attributes?: Record<string, string> }> = await res.json();
      const pick = rows.find((r) => Object.values(r.attributes ?? {}).some((v) => /XAU\/?USD$/i.test(v)));
      if (pick) {
        goldFeed = { id: pick.id.startsWith("0x") ? pick.id : `0x${pick.id}`, source: "lookup" };
        return goldFeed;
      }
    } catch {
      // try the next query
    }
  }
  goldFeed = { id: KNOWN_XAU_USD, source: "fallback" };
  return goldFeed;
}

/** Open the Hermes price stream, trying each host. Collects a readable reason for every failure. */
async function openUpstream() {
  const errors: string[] = [];
  for (const host of HERMES_HOSTS()) {
    try {
      const feed = await resolveFeedId(host);
      const res = await fetch(`${host}/v2/updates/price/stream?ids[]=${feed.id}&parsed=true&encoding=hex`, {
        headers: { Authorization: `Bearer ${hermesKey()}`, Accept: "text/event-stream" },
      });
      if (res.ok && res.body) return { res, host, feed, errors };
      errors.push(`${new URL(host).host}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    } catch (e) {
      errors.push(`${new URL(host).host}: ${(e as Error).message}`);
    }
  }
  throw new Error(`Pyth tick stream unavailable — ${errors.join(" | ")}`);
}

/** One-shot check of the tick stream: which host and feed work, and the first price received. */
async function tickDiagnostics() {
  try {
    const { res, host, feed, errors } = await openUpstream();
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const deadline = Date.now() + 8000;
    let buf = "";
    let firstPrice: number | null = null;
    while (Date.now() < deadline && firstPrice === null) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value?: undefined }>((ok) => setTimeout(() => ok({ done: true }), 8000))]);
      if (r.done) break;
      buf += r.value;
      const m = buf.match(/data:(.*)\n/);
      if (m) {
        try {
          const pr = JSON.parse(m[1]).parsed?.[0]?.price;
          if (pr) firstPrice = Number(pr.price) * 10 ** Number(pr.expo);
        } catch {
          // keep reading
        }
      }
    }
    reader.cancel().catch(() => {});
    return {
      ok: firstPrice !== null,
      host: new URL(host).host,
      feedId: feed.id,
      feedSource: feed.source,
      firstPrice,
      problems: firstPrice === null ? [...errors, "connected but no price arrived within 8s (wrong feed id, or market closed?)"] : errors,
    };
  } catch (e) {
    return { ok: false, host: null, feedId: goldFeed?.id ?? null, feedSource: goldFeed?.source ?? null, firstPrice: null, problems: [(e as Error).message] };
  }
}

// Edge functions have a wall-clock limit, so each stream ends after ~2 minutes and the page reconnects.
const STREAM_MS = 120_000;

async function tickStream(): Promise<Response> {
  const { res: upstream } = await openUpstream();
  const reader = upstream.body!.pipeThrough(new TextDecoderStream()).getReader();
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

// ── Jev: its own call, and a fact-check of the model's call ───────────
// Two requests in parallel so Jev's own call is made WITHOUT seeing the model (no anchoring); the fact-check
// sees the same data plus the model's call. Cached per candle, so every viewer and the backfill share one answer.

const inflight = new Map<string, Promise<unknown>>();
const INSTRUMENT = "Gold (XAU/USD), 15-minute candles";

async function ask(state: Record<string, unknown>, question: Record<string, unknown>) {
  const res = await fetch(TYPESAFE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("TYPESAFE_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env("JEV_MODEL") || "jev-latest", state, questions: { q: question } }),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const r = await res.json();
  const a = r?.answers?.q;
  if (!a) throw new Error("unexpected TypeSafe response shape");
  return a;
}

async function check(data: Record<string, unknown>, model: Record<string, unknown>) {
  const own = ask(
    { instrument: INSTRUMENT, ...data },
    {
      type: "choice",
      instructions:
        "Using only the candles and signals given, will the NEXT 15-minute candle close above or below its open?",
      criteria: {
        green: "It closes above its open",
        red: "It closes below its open",
      },
    },
  );
  const modelCall = model?.call;
  const factCheck =
    modelCall === "green" || modelCall === "red"
      ? ask(
          { instrument: INSTRUMENT, ...data, model },
          {
            type: "score",
            instructions:
              `A model predicts the next 15-minute candle will close ${modelCall} (see model.p_green and its track record). ` +
              "Fact-check that call against the candles and signals: how well does the evidence support it?",
            criteria: [
              "The evidence points the other way",
              "The evidence is mixed or weak",
              "The evidence mostly supports the call",
              "The evidence clearly supports the call",
            ],
          },
        )
      : Promise.resolve(null);
  const [a, f] = await Promise.all([own, factCheck]);
  if ((a.choice !== "green" && a.choice !== "red") || typeof a.probabilities?.green !== "number") {
    throw new Error("unexpected TypeSafe response shape");
  }
  return {
    pGreen: a.probabilities.green,
    confidence: typeof a.confidence === "number" ? a.confidence : null,
    support: f && typeof f.score === "number" ? f.score : null,
  };
}

// ── Jev: will the forming candle flip before it closes? ─────────────────

async function flip(state: Record<string, unknown>) {
  const a = await ask(
    { instrument: INSTRUMENT, candle_so_far: state },
    {
      type: "choice",
      instructions:
        "This 15-minute candle is still forming (see candle_so_far, current_color). Will it HOLD its current color " +
        "until it closes, or FLIP to the other color? Compare move_so_far with typical_move_in_time_left, and weigh " +
        "how far it has already pulled back from its extreme and the last few candles.",
      criteria: {
        holds: "It closes the same color it is now",
        flips: "It reverses and closes the opposite color",
      },
    },
  );
  if (typeof a.probabilities?.flips !== "number") throw new Error("unexpected TypeSafe response shape");
  return { pFlip: a.probabilities.flips, confidence: typeof a.confidence === "number" ? a.confidence : null };
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
      return json({ version: 10, features: ["stream", "tickcheck", "jev-check", "jev-flip"], jev: !!env("TYPESAFE_API_KEY") });
    }

    if (body.action === "tickcheck") {
      if (!hermesKey()) return json({ ok: false, problems: ["PYTH_API_KEY secret is not set"] });
      return json(await tickDiagnostics());
    }

    if (body.action === "stream") {
      if (!hermesKey()) return json({ error: "PYTH_API_KEY secret is not set" }, 503);
      return await tickStream();
    }

    if (body.action === "check") {
      if (!env("TYPESAFE_API_KEY")) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503);
      const { snapshot, forTime } = body as { snapshot?: { data?: unknown; model?: unknown }; forTime?: unknown };
      if (!snapshot || typeof snapshot.data !== "object" || !snapshot.data || typeof snapshot.model !== "object" || !snapshot.model) {
        return json({ error: "bad snapshot" }, 400);
      }
      if (JSON.stringify(snapshot).length > 6000) return json({ error: "snapshot too large" }, 400);
      if (typeof forTime !== "number") return json({ error: "forTime must be a number" }, 400);

      const key = `check:${forTime}`;
      const hit = cached<unknown>(jevCache, key, 60 * 60 * 1000);
      if (hit) return json(hit);
      let run = inflight.get(key);
      if (!run) {
        run = check(snapshot.data as Record<string, unknown>, snapshot.model as Record<string, unknown>).then((r) => {
          jevCache.set(key, { at: Date.now(), body: r });
          return r;
        });
        inflight.set(key, run);
        run.finally(() => inflight.delete(key)).catch(() => {});
      }
      return json(await run);
    }

    if (body.action === "flip") {
      if (!env("TYPESAFE_API_KEY")) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503);
      const { state, slotKey } = body as { state?: unknown; slotKey?: unknown };
      if (!state || typeof state !== "object" || JSON.stringify(state).length > 2000) return json({ error: "bad state" }, 400);
      if (typeof slotKey !== "string" || slotKey.length > 64) return json({ error: "bad slotKey" }, 400);
      // Shared per 30-second slot (live) or per past candle (replay), so viewers and reloads reuse one answer.
      const key = `flip:${slotKey}`;
      const hit = cached<unknown>(jevCache, key, slotKey.startsWith("past:") ? 6 * 3600 * 1000 : 60_000);
      if (hit) return json(hit);
      let run = inflight.get(key);
      if (!run) {
        run = flip(state as Record<string, unknown>).then((r) => {
          jevCache.set(key, { at: Date.now(), body: r });
          return r;
        });
        inflight.set(key, run);
        run.finally(() => inflight.delete(key)).catch(() => {});
      }
      return json(await run);
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 502);
  }
});
