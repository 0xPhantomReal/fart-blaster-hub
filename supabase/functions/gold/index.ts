// Supabase edge function for the /gold page (gold and bitcoin). Holds the Pyth, TypeSafe and Kalshi keys so the
// browser never sees them.
// Secrets: PYTH_API_KEY, TYPESAFE_API_KEY; for live BRTI: KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY
// (optional: PYTH_SYMBOL, PYTH_BTC_SYMBOL, PYTH_HERMES_KEY, PYTH_GOLD_FEED_ID, PYTH_BTC_FEED_ID, JEV_MODEL, KALSHI_WS_URL)
// Every action takes an optional `market`: "gold" (default) or a crypto key (btc, eth, sol, xrp, bnb, doge, hype, zec).
//
// POST { action: "history", from, to, resolution } → { candles, jev }
// POST { action: "stream" }                        → NDJSON lines { t, p } on every Pyth price tick
// POST { action: "check", snapshot, forTime, timeframeMin }  → { pGreen, support, confidence }  (Jev: own call + fact-check)
// POST { action: "flip", state, slotKey, timeframeMin }      → { pFlip, confidence }  (Jev: will the forming candle flip?)
// POST { action: "forecast", data, options, forTime, timeframeMin } → { choice, probabilities }  (Jev: most likely 5-candle path)
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

// ── Markets ────────────────────────────────────────────────────────────
// gold: Pyth XAU/USD for history and live ticks.
// btc, eth, sol, xrp: live ticks from the CME CF Real Time Index (BRTI, ETHUSD_RTI, …) via Kalshi's CF Benchmarks
//       feed (needs Kalshi API secrets); history, and live ticks when the index isn't available, from Pyth.
//       Volume for Jev's context from Coinbase.

type Market = "gold" | "btc" | "eth" | "sol" | "xrp" | "bnb" | "doge" | "hype" | "zec";
interface MarketCfg {
  instrument: string; //   how Jev is told what it's looking at
  symbolEnv: string; //    secret that overrides the Pyth history symbol
  symbolQuery: string;
  symbolRe: RegExp;
  symbolDefault: string;
  feedEnv: string; //      secret that overrides the Hermes feed id
  feedQueries: string[];
  feedRe: RegExp;
  knownFeed: string; //    used only if the lookup fails
  cfIndex?: string; //     CF Benchmarks index id on Kalshi's feed
  coinbase?: string; //    Coinbase product for volume
  slowIndex?: boolean; //  index only on Kalshi's once-per-second channel (not the 5-per-second one)
}
const MARKETS: Record<Market, MarketCfg> = {
  gold: {
    instrument: "Gold (XAU/USD)",
    symbolEnv: "PYTH_SYMBOL",
    symbolQuery: "query=XAU&asset_type=metal",
    symbolRe: /XAU\/?USD$/i,
    symbolDefault: "Metal.XAU/USD",
    feedEnv: "PYTH_GOLD_FEED_ID",
    feedQueries: ["query=XAU&asset_type=metal", "query=XAU&asset_type=metals", "query=XAU"],
    feedRe: /XAU\/?USD$/i,
    knownFeed: "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  },
  btc: {
    instrument: "Bitcoin (BTC/USD, CME CF Bitcoin Real Time Index)",
    symbolEnv: "PYTH_BTC_SYMBOL",
    symbolQuery: "query=BTC&asset_type=crypto",
    symbolRe: /^Crypto\.BTC\/USD$/i,
    symbolDefault: "Crypto.BTC/USD",
    feedEnv: "PYTH_BTC_FEED_ID",
    feedQueries: ["query=BTC&asset_type=crypto", "query=BTC"],
    feedRe: /^Crypto\.BTC\/USD$/i,
    knownFeed: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    cfIndex: "BRTI",
    coinbase: "BTC-USD",
  },
  eth: {
    instrument: "Ether (ETH/USD, CME CF Ether-Dollar Real Time Index)",
    symbolEnv: "PYTH_ETH_SYMBOL",
    symbolQuery: "query=ETH&asset_type=crypto",
    symbolRe: /^Crypto\.ETH\/USD$/i,
    symbolDefault: "Crypto.ETH/USD",
    feedEnv: "PYTH_ETH_FEED_ID",
    feedQueries: ["query=ETH&asset_type=crypto", "query=ETH"],
    feedRe: /^Crypto\.ETH\/USD$/i,
    knownFeed: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    cfIndex: "ETHUSD_RTI",
    coinbase: "ETH-USD",
  },
  sol: {
    instrument: "Solana (SOL/USD, CME CF Solana-Dollar Real Time Index)",
    symbolEnv: "PYTH_SOL_SYMBOL",
    symbolQuery: "query=SOL&asset_type=crypto",
    symbolRe: /^Crypto\.SOL\/USD$/i,
    symbolDefault: "Crypto.SOL/USD",
    feedEnv: "PYTH_SOL_FEED_ID",
    feedQueries: ["query=SOL&asset_type=crypto", "query=SOL"],
    feedRe: /^Crypto\.SOL\/USD$/i,
    knownFeed: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    cfIndex: "SOLUSD_RTI",
    coinbase: "SOL-USD",
  },
  xrp: {
    instrument: "XRP (XRP/USD, CME CF XRP-Dollar Real Time Index)",
    symbolEnv: "PYTH_XRP_SYMBOL",
    symbolQuery: "query=XRP&asset_type=crypto",
    symbolRe: /^Crypto\.XRP\/USD$/i,
    symbolDefault: "Crypto.XRP/USD",
    feedEnv: "PYTH_XRP_FEED_ID",
    feedQueries: ["query=XRP&asset_type=crypto", "query=XRP"],
    feedRe: /^Crypto\.XRP\/USD$/i,
    knownFeed: "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
    cfIndex: "XRPUSD_RTI",
    coinbase: "XRP-USD",
  },
  bnb: {
    instrument: "BNB (BNB/USD, CF BNB-Dollar Spot Rate)",
    symbolEnv: "PYTH_BNB_SYMBOL",
    symbolQuery: "query=BNB&asset_type=crypto",
    symbolRe: /^Crypto\.BNB\/USD$/i,
    symbolDefault: "Crypto.BNB/USD",
    feedEnv: "PYTH_BNB_FEED_ID",
    feedQueries: ["query=BNB&asset_type=crypto", "query=BNB"],
    feedRe: /^Crypto\.BNB\/USD$/i,
    knownFeed: "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
    cfIndex: "BNBUSD_RTI",
    slowIndex: true,
  },
  doge: {
    instrument: "Dogecoin (DOGE/USD, CF Dogecoin-Dollar Spot Rate)",
    symbolEnv: "PYTH_DOGE_SYMBOL",
    symbolQuery: "query=DOGE&asset_type=crypto",
    symbolRe: /^Crypto\.DOGE\/USD$/i,
    symbolDefault: "Crypto.DOGE/USD",
    feedEnv: "PYTH_DOGE_FEED_ID",
    feedQueries: ["query=DOGE&asset_type=crypto", "query=DOGE"],
    feedRe: /^Crypto\.DOGE\/USD$/i,
    knownFeed: "0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c",
    cfIndex: "DOGEUSD_RTI",
    coinbase: "DOGE-USD",
  },
  hype: {
    instrument: "Hyperliquid (HYPE/USD, CF Hyperliquid-Dollar Spot Rate)",
    symbolEnv: "PYTH_HYPE_SYMBOL",
    symbolQuery: "query=HYPE&asset_type=crypto",
    symbolRe: /^Crypto\.HYPE\/USD$/i,
    symbolDefault: "Crypto.HYPE/USD",
    feedEnv: "PYTH_HYPE_FEED_ID",
    feedQueries: ["query=HYPE&asset_type=crypto", "query=HYPE"],
    feedRe: /^Crypto\.HYPE\/USD$/i,
    knownFeed: "0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b",
    cfIndex: "HYPEUSD_RTI",
    slowIndex: true,
  },
  zec: {
    instrument: "Zcash (ZEC/USD, CF Zcash-Dollar Spot Rate)",
    symbolEnv: "PYTH_ZEC_SYMBOL",
    symbolQuery: "query=ZEC&asset_type=crypto",
    symbolRe: /^Crypto\.ZEC\/USD$/i,
    symbolDefault: "Crypto.ZEC/USD",
    feedEnv: "PYTH_ZEC_FEED_ID",
    feedQueries: ["query=ZEC&asset_type=crypto", "query=ZEC"],
    feedRe: /^Crypto\.ZEC\/USD$/i,
    knownFeed: "0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24",
    cfIndex: "ZECUSD_RTI",
    coinbase: "ZEC-USD",
    slowIndex: true,
  },
};
/** Market from the request (older pages don't send one: they are on gold). */
const marketOf = (b: Record<string, unknown>): Market =>
  typeof b.market === "string" && b.market in MARKETS ? (b.market as Market) : "gold";

// ── Pyth ───────────────────────────────────────────────────────────────

const symbols: Partial<Record<Market, string>> = {};

async function resolveSymbol(m: Market): Promise<string> {
  const cfg = MARKETS[m];
  if (env(cfg.symbolEnv)) return env(cfg.symbolEnv);
  if (symbols[m]) return symbols[m]!;
  try {
    const res = await fetch(`${PYTH_BASE}/symbols?${cfg.symbolQuery}`);
    const list = await res.json();
    const rows: Array<Record<string, string>> = Array.isArray(list) ? list : (list.symbols ?? []);
    const names = rows.map((r) => r.symbol ?? r.name ?? "").filter(Boolean);
    symbols[m] = names.find((n) => cfg.symbolRe.test(n)) ?? cfg.symbolDefault;
  } catch {
    symbols[m] = cfg.symbolDefault;
  }
  return symbols[m]!;
}

async function history(m: Market, from: number, to: number, resolution: number) {
  // Round `to` down to 5s so near-simultaneous viewers share one upstream call.
  const toR = Math.floor(to / 5) * 5;
  const key = `${m}:${from}:${toR}:${resolution}`;
  const hit = cached<unknown>(historyCache, key, 4000);
  if (hit) return hit;

  const symbol = await resolveSymbol(m);
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
type FeedRef = { id: string; source: "secret" | "lookup" | "fallback" };
const feeds: Partial<Record<Market, FeedRef>> = {};

async function resolveFeedId(host: string, m: Market): Promise<FeedRef> {
  const cfg = MARKETS[m];
  if (env(cfg.feedEnv)) return { id: env(cfg.feedEnv), source: "secret" };
  const known = feeds[m];
  if (known && known.source !== "fallback") return known;
  for (const q of cfg.feedQueries) {
    try {
      const res = await fetch(`${host}/v2/price_feeds?${q}`, { headers: { Authorization: `Bearer ${hermesKey()}` } });
      if (!res.ok) continue;
      const rows: Array<{ id: string; attributes?: Record<string, string> }> = await res.json();
      const pick = rows.find((r) => Object.values(r.attributes ?? {}).some((v) => cfg.feedRe.test(v)));
      if (pick) return (feeds[m] = { id: pick.id.startsWith("0x") ? pick.id : `0x${pick.id}`, source: "lookup" });
    } catch {
      // try the next query
    }
  }
  return (feeds[m] = { id: cfg.knownFeed, source: "fallback" });
}

/** Open the Hermes price stream, trying each host. Collects a readable reason for every failure. */
async function openUpstream(m: Market) {
  const errors: string[] = [];
  for (const host of HERMES_HOSTS()) {
    try {
      const feed = await resolveFeedId(host, m);
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

/** Pull prices out of Hermes SSE text. Returns what's left of an unfinished line. */
function parseHermes(buf: string, emit: (t: number, p: number) => void): string {
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
        if (Number.isFinite(price)) emit(Number(pr.publish_time), price);
      }
    } catch {
      // skip partial or non-price lines
    }
  }
  return buf;
}

// ── BRTI via Kalshi's CF Benchmarks feed ──────────────────────────────
// Secrets: KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY (the private key file Kalshi gives you, PEM text).

const KALSHI_WS = () => env("KALSHI_WS_URL") || "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const kalshiConfigured = () => !!(env("KALSHI_API_KEY_ID") && env("KALSHI_PRIVATE_KEY"));

function pemBytes(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const text = pem.replace(/\\n/g, "\n");
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(text);
  const b64 = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return { der: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), pkcs1 };
}

/** Wrap a PKCS#1 RSA key in PKCS#8 (what WebCrypto imports). */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const len = (n: number) => (n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255]);
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...len(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  return new Uint8Array([0x30, ...len(inner.length + pkcs1.length), ...inner, ...pkcs1]);
}

let kalshiKey: Promise<{ key: CryptoKey; algo: AlgorithmIdentifier | RsaPssParams }> | null = null;
function loadKalshiKey() {
  kalshiKey ??= (async () => {
    const { der, pkcs1 } = pemBytes(env("KALSHI_PRIVATE_KEY"));
    const pkcs8 = new Uint8Array(pkcs1 ? pkcs1ToPkcs8(der) : der).buffer as ArrayBuffer;
    try {
      const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
      return { key, algo: { name: "RSA-PSS", saltLength: 32 } };
    } catch {
      const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
      return { key, algo: { name: "Ed25519" } };
    }
  })();
  kalshiKey.catch(() => (kalshiKey = null));
  return kalshiKey;
}

async function kalshiHeaders(path: string) {
  const { key, algo } = await loadKalshiKey();
  const ts = String(Date.now());
  const sig = new Uint8Array(await crypto.subtle.sign(algo, key, new TextEncoder().encode(ts + "GET" + path)));
  return {
    "KALSHI-ACCESS-KEY": env("KALSHI_API_KEY_ID"),
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...sig)),
    "KALSHI-ACCESS-TIMESTAMP": ts,
  };
}

/**
 * Minimal WebSocket client over a raw TLS (or TCP) connection, so the handshake can carry Kalshi's signed
 * headers. Text messages, ping/pong and close only — all this feed needs. Same callback names as WebSocket.
 */
class HeaderSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  private conn: Deno.Conn | null = null;
  private closed = false;
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  constructor(url: string, headers: Record<string, string>) {
    this.run(new URL(url), headers).catch((e) => this.fail((e as Error).message));
  }

  private fail(message: string) {
    if (this.closed) return;
    this.onerror?.({ message });
    this.finish(1006, message);
  }

  private finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
    this.onclose?.({ code, reason });
  }

  private async run(u: URL, headers: Record<string, string>) {
    const secure = u.protocol === "wss:";
    const port = Number(u.port || (secure ? 443 : 80));
    this.conn = secure ? await Deno.connectTls({ hostname: u.hostname, port }) : await Deno.connect({ hostname: u.hostname, port });
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const lines = [
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    await this.write(this.enc.encode(lines.join("\r\n") + "\r\n\r\n"));

    // Read the HTTP response head.
    let buf = new Uint8Array(0);
    const chunk = new Uint8Array(16384);
    let headEnd = -1;
    while (headEnd < 0) {
      const n = await this.conn.read(chunk);
      if (n === null) throw new Error("connection closed during handshake");
      buf = concat(buf, chunk.subarray(0, n));
      headEnd = indexOfCrlf2(buf);
      if (buf.length > 65536) throw new Error("bad handshake response");
    }
    const head = this.dec.decode(buf.subarray(0, headEnd));
    const status = Number(head.split(" ")[1]);
    if (status !== 101) throw new Error(`Invalid status code: ${status}`);
    buf = buf.subarray(headEnd + 4);
    this.onopen?.();

    // Frames.
    let parts: Uint8Array[] = [];
    while (!this.closed) {
      const f = parseFrame(buf);
      if (!f) {
        const n = await this.conn.read(chunk);
        if (n === null) return this.finish(1006, "connection closed");
        buf = concat(buf, chunk.subarray(0, n));
        continue;
      }
      buf = buf.subarray(f.size);
      if (f.op === 0x8) {
        const code = f.payload.length >= 2 ? (f.payload[0] << 8) | f.payload[1] : 1005;
        return this.finish(code, this.dec.decode(f.payload.subarray(2)));
      }
      if (f.op === 0x9) await this.frame(0xa, f.payload); // ping → pong
      else if (f.op === 0x1 || f.op === 0x0) {
        parts.push(f.payload);
        if (f.fin) {
          const all = parts.reduce((a, b) => concat(a, b), new Uint8Array(0));
          parts = [];
          this.onmessage?.({ data: this.dec.decode(all) });
        }
      }
    }
  }

  private async write(b: Uint8Array) {
    let off = 0;
    while (off < b.length) off += await this.conn!.write(b.subarray(off));
  }

  /** Send one masked frame (clients must mask). */
  private async frame(op: number, payload: Uint8Array) {
    const len = payload.length;
    const head = len < 126 ? [0x80 | op, 0x80 | len] : len < 65536 ? [0x80 | op, 0x80 | 126, len >> 8, len & 255] : null;
    if (!head) throw new Error("message too large");
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const out = new Uint8Array(head.length + 4 + len);
    out.set(head, 0);
    out.set(mask, head.length);
    for (let i = 0; i < len; i++) out[head.length + 4 + i] = payload[i] ^ mask[i & 3];
    await this.write(out);
  }

  send(text: string) {
    if (this.closed) return;
    this.frame(0x1, this.enc.encode(text)).catch((e) => this.fail((e as Error).message));
  }

  close() {
    if (this.closed) return;
    this.frame(0x8, new Uint8Array([0x03, 0xe8]))
      .catch(() => {})
      .finally(() => this.finish(1000, ""));
  }
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfCrlf2(b: Uint8Array) {
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
}

/** One server frame from the start of `b`, or null if it hasn't fully arrived. */
function parseFrame(b: Uint8Array): { fin: boolean; op: number; payload: Uint8Array; size: number } | null {
  if (b.length < 2) return null;
  const fin = (b[0] & 0x80) !== 0;
  const op = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = (b[2] << 8) | b[3];
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(new DataView(b.buffer, b.byteOffset + 2, 8).getBigUint64(0));
    off = 10;
  }
  const maskAt = off;
  if (masked) off += 4;
  if (b.length < off + len) return null;
  let payload = b.subarray(off, off + len);
  if (masked) {
    const m = b.subarray(maskAt, maskAt + 4);
    payload = payload.map((v, i) => v ^ m[i & 3]);
  }
  return { fin, op, payload, size: off + len };
}

/**
 * Open Kalshi's CF Benchmarks feed for BRTI and resolve once the first value arrives (or reject with the reason).
 * Tries the 5-per-second channel, then the once-per-second one.
 */
async function openBrti(index: string, slow: boolean, onTick: (t: number, p: number) => void, onEnd: () => void = () => {}): Promise<{ close: () => void; channel: string }> {
  if (!kalshiConfigured()) throw new Error("Kalshi API secrets (KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY) are not set");
  const url = KALSHI_WS();
  const headers = await kalshiHeaders(new URL(url).pathname);
  return await new Promise((resolve, reject) => {
    // Supabase's edge runtime can't send headers with its built-in WebSocket ("Invalid protocol value"),
    // so connect with a small client that can.
    const ws = new HeaderSocket(url, headers);
    let settled = false;
    let channel = slow ? "cfbenchmarks_value" : "cfbenchmarks_value_5hz";
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail(`no ${index} value from Kalshi within 8s`), 8000);
    const subscribe = (ch: string, id: number) =>
      ws.send(JSON.stringify({ id, cmd: "subscribe", params: { channels: [ch], index_ids: [index] } }));
    ws.onopen = () => subscribe(channel, 1);
    ws.onerror = (e) => fail(`Kalshi websocket error: ${(e as ErrorEvent).message ?? "connection failed"}`);
    ws.onclose = (e) => fail(`Kalshi closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ""})`);
    ws.onmessage = (e) => {
      let m: { type?: string; msg?: Record<string, unknown> };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === "error") {
        if (channel === "cfbenchmarks_value_5hz") {
          channel = "cfbenchmarks_value"; // fall back to the 1-per-second channel
          return subscribe(channel, 2);
        }
        return fail(`Kalshi: ${String(m.msg?.msg ?? m.msg?.code ?? "subscribe error")}`);
      }
      let t: number | null = null;
      let p: number | null = null;
      if (m.type === "cfbenchmarks_value_5hz" && m.msg?.index_id === index) {
        p = Number(m.msg.value_usd);
        t = Number(m.msg.source_ts_ms) / 1000;
      } else if (m.type === "cfbenchmarks_value" && m.msg?.index_id === index) {
        try {
          const raw = JSON.parse(String(m.msg.data));
          p = Number(raw.value);
          t = Number(raw.time ?? m.msg.received_at) / 1000;
        } catch {
          return;
        }
      }
      if (t === null || p === null || !Number.isFinite(p) || !Number.isFinite(t)) return;
      onTick(t, p);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        ws.onclose = () => onEnd(); // the page reconnects
        ws.onerror = null;
        resolve({ close: () => ws.close(), channel });
      }
    };
  });
}

/** One-shot check of the tick stream: which source/host/feed works, and the first price received. */
async function tickDiagnostics(m: Market) {
  const brti: { ok: boolean; problem: string | null } = { ok: false, problem: null };
  const index = MARKETS[m].cfIndex;
  if (index) {
    try {
      const c = await openBrti(index, !!MARKETS[m].slowIndex, () => {});
      c.close();
      brti.ok = true;
    } catch (e) {
      brti.problem = (e as Error).message;
    }
  }
  try {
    const { res, host, feed, errors } = await openUpstream(m);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const deadline = Date.now() + 8000;
    let buf = "";
    let firstPrice: number | null = null;
    while (Date.now() < deadline && firstPrice === null) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value?: undefined }>((ok) => setTimeout(() => ok({ done: true }), 8000))]);
      if (r.done) break;
      buf = parseHermes(buf + r.value, (_t, p) => (firstPrice ??= p));
    }
    reader.cancel().catch(() => {});
    return {
      ok: firstPrice !== null,
      host: new URL(host).host,
      feedId: feed.id,
      feedSource: feed.source,
      firstPrice,
      brti: index ? brti : undefined,
      problems: firstPrice === null ? [...errors, "connected but no price arrived within 8s (wrong feed id, or market closed?)"] : errors,
    };
  } catch (e) {
    return { ok: false, host: null, feedId: feeds[m]?.id ?? null, feedSource: feeds[m]?.source ?? null, firstPrice: null, brti, problems: [(e as Error).message] };
  }
}

// Edge functions have a wall-clock limit, so each stream ends after ~2 minutes and the page reconnects.
const STREAM_MS = 120_000;

/**
 * NDJSON for the browser: a first line { source, note? }, then { t, p } on every tick. Bitcoin streams BRTI when
 * Kalshi is set up, otherwise Pyth BTC/USD (the note says why).
 */
async function tickStream(m: Market): Promise<Response> {
  const enc = new TextEncoder();
  const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
  let note: string | null = null;

  const index = MARKETS[m].cfIndex;
  if (index) {
    const early: Uint8Array[] = [];
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const push = (t: number, p: number) => {
      const l = line({ t, p });
      if (ctl) ctl.enqueue(l);
      else early.push(l);
    };
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const end = () => {
        clearTimeout(timer);
        try {
          ctl?.close();
        } catch {
          // already closed
        }
      };
      const brti = await openBrti(index, !!MARKETS[m].slowIndex, push, end);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          ctl = controller;
          controller.enqueue(line({ source: index, note: `CF Benchmarks via Kalshi (${brti.channel})` }));
          for (const l of early) controller.enqueue(l);
          timer = setTimeout(() => {
            brti.close();
            try {
              controller.close();
            } catch {
              // already closed
            }
          }, STREAM_MS);
        },
        cancel() {
          clearTimeout(timer);
          brti.close();
        },
      });
      return new Response(body, { headers: { ...cors, "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
    } catch (e) {
      note = `${index} unavailable (${(e as Error).message}); using Pyth ${MARKETS[m].symbolDefault.replace("Crypto.", "")}`;
    }
  }

  const { res: upstream } = await openUpstream(m);
  const reader = upstream.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(line({ source: "Pyth", note }));
      const timer = setTimeout(() => reader.cancel().catch(() => {}), STREAM_MS);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf = parseHermes(buf + value, (t, p) => controller.enqueue(line({ t, p })));
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

// ── Bitcoin volume (Coinbase BTC-USD public candles; no key needed) ──
// Pyth and BRTI carry no volume, so Jev's bitcoin context uses Coinbase's (a BRTI constituent exchange).

const COINBASE = "https://api.exchange.coinbase.com/products";
const volumeCache = new Map<string, { at: number; body: unknown }>();

async function volume(product: string, from: number, to: number, granularity: number) {
  const key = `${product}:${from}:${Math.floor(to / 30)}:${granularity}`;
  const hit = cached<unknown>(volumeCache, key, 30_000);
  if (hit) return hit;
  const out: { time: number; volume: number }[] = [];
  const step = granularity * 300; // Coinbase returns at most 300 candles per request
  for (let a = from; a < to; a += step) {
    const b = Math.min(to, a + step);
    const q = new URLSearchParams({
      granularity: String(granularity),
      start: new Date(a * 1000).toISOString(),
      end: new Date(b * 1000).toISOString(),
    });
    const res = await fetch(`${COINBASE}/${product}/candles?${q}`, { headers: { Accept: "application/json", "User-Agent": "gold-chart/1.0" } });
    if (!res.ok) throw new Error(`Coinbase ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const rows: number[][] = await res.json();
    for (const r of rows) out.push({ time: r[0], volume: r[5] });
  }
  const body = { volume: out.sort((p, q) => p.time - q.time) };
  volumeCache.set(key, { at: Date.now(), body });
  return body;
}

// ── Trades (Coinbase public, no key): for order flow / footprints ───
// Coinbase pages trades by trade id, newest first: `after=X` returns the 1000 trades just older than id X.

const tradesCache = new Map<string, { at: number; body: unknown }>();

async function tradesPage(product: string, after: number | null) {
  const key = `${product}:${after}`;
  const hit = after === null ? undefined : cached<unknown>(tradesCache, key, 6 * 3600 * 1000); // old pages never change
  if (hit) return hit;
  const q = new URLSearchParams({ limit: "1000" });
  if (after !== null) q.set("after", String(after));
  const res = await fetch(`${COINBASE}/${product}/trades?${q}`, { headers: { Accept: "application/json", "User-Agent": "gold-chart/1.0" } });
  if (!res.ok) throw new Error(`Coinbase ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const rows: { time: string; trade_id: number; price: string; size: string; side: string }[] = await res.json();
  // [time (s), price, size, 1 = aggressive buy (maker side "sell"), trade id]
  const trades = rows.map((r) => [Date.parse(r.time) / 1000, Number(r.price), Number(r.size), r.side === "sell" ? 1 : 0, r.trade_id]);
  const ids = rows.map((r) => r.trade_id);
  const body = { trades, minId: ids.length ? Math.min(...ids) : null, maxId: ids.length ? Math.max(...ids) : null };
  if (after !== null) tradesCache.set(key, { at: Date.now(), body });
  return body;
}

// ── Jev: its own call, and a fact-check of the model's call ───────────
// Two requests in parallel so Jev's own call is made WITHOUT seeing the model (no anchoring); the fact-check
// sees the same data plus the model's call. Cached per candle, so every viewer and the backfill share one answer.

const inflight = new Map<string, Promise<unknown>>();
const TIMEFRAMES = new Set([1, 5, 15]);
const instrument = (m: Market, tf: number) => `${MARKETS[m].instrument}, ${tf}-minute candles`;
/** Timeframe from the request (older pages don't send one: they are on 15-minute candles). */
const tfOf = (b: Record<string, unknown>) => (TIMEFRAMES.has(b.timeframeMin as number) ? (b.timeframeMin as number) : 15);

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

async function check(m: Market, data: Record<string, unknown>, model: Record<string, unknown>, tf: number) {
  const own = ask(
    { instrument: instrument(m, tf), ...data },
    {
      type: "choice",
      instructions:
        `Using the recent candles, signals, bigger trend, key levels (day/24h highs and lows, round numbers), volatility, ` +
          `hourly and 4-hour candles and (if given) volume: will the NEXT ${tf}-minute candle close above or below its open?`,
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
          { instrument: instrument(m, tf), ...data, model },
          {
            type: "score",
            instructions:
              `A model predicts the next ${tf}-minute candle will close ${modelCall} (see model.p_green and its track record). ` +
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

async function flip(m: Market, state: Record<string, unknown>, tf: number) {
  const a = await ask(
    { instrument: instrument(m, tf), candle_so_far: state },
    {
      type: "choice",
      instructions:
        `This ${tf}-minute candle is still forming (see candle_so_far, current_color). Will it HOLD its current color ` +
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

// ── Jev: which of ~50 real past 5-candle paths is most likely next? ─────

async function forecast(m: Market, data: Record<string, unknown>, options: Record<string, string>, tf: number) {
  const a = await ask(
    { instrument: instrument(m, tf), ...data },
    {
      type: "choice",
      instructions:
        `Each option is a sequence of the next 5 ${tf}-minute candles that this market really produced after a moment that ` +
        "looked like now. Per candle: G/R = green/red, then the body (signed), ^ upper wick, v lower wick, all in ATR " +
        "units. Given the recent candles and signals, which sequence is the most likely to happen next?",
      criteria: options,
    },
  );
  if (typeof a.choice !== "string" || !(a.choice in options)) throw new Error("unexpected TypeSafe response shape");
  return { choice: a.choice, probabilities: a.probabilities ?? {} };
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
      return json(await history(marketOf(body), Math.floor(from), Math.floor(to), resolution));
    }

    if (body.action === "version") {
      // Lets the page check which backend is deployed (older versions answer "unknown action").
      return json({
        version: 16,
        features: ["stream", "tickcheck", "jev-check", "jev-flip", "timeframes", "jev-forecast", "markets", "volume", "crypto4", "crypto8", "trades"],
        brti: kalshiConfigured(),
        jev: !!env("TYPESAFE_API_KEY"),
      });
    }

    if (body.action === "volume") {
      const { from, to, granularity } = body as { from?: unknown; to?: unknown; granularity?: unknown };
      const product = MARKETS[marketOf(body)].coinbase;
      if (!product) return json({ volume: [] });
      if (typeof from !== "number" || typeof to !== "number" || ![300, 900].includes(granularity as number)) {
        return json({ error: "from, to and granularity (300 or 900) required" }, 400);
      }
      if (to <= from || to - from > (granularity as number) * 1500) return json({ error: "bad time range" }, 400);
      return json(await volume(product, Math.floor(from), Math.floor(to), granularity as number));
    }

    if (body.action === "trades") {
      const product = MARKETS[marketOf(body)].coinbase;
      if (!product) return json({ error: "no trade data for this market" }, 400);
      const after = body.after;
      if (after !== undefined && after !== null && (typeof after !== "number" || !Number.isInteger(after) || after <= 0)) {
        return json({ error: "after must be a trade id" }, 400);
      }
      return json(await tradesPage(product, (after as number | undefined) ?? null));
    }

    if (body.action === "tickcheck") {
      if (!hermesKey()) return json({ ok: false, problems: ["PYTH_API_KEY secret is not set"] });
      return json(await tickDiagnostics(marketOf(body)));
    }

    if (body.action === "stream") {
      if (!hermesKey()) return json({ error: "PYTH_API_KEY secret is not set" }, 503);
      return await tickStream(marketOf(body));
    }

    if (body.action === "check") {
      if (!env("TYPESAFE_API_KEY")) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503);
      const { snapshot, forTime } = body as { snapshot?: { data?: unknown; model?: unknown }; forTime?: unknown };
      if (!snapshot || typeof snapshot.data !== "object" || !snapshot.data || typeof snapshot.model !== "object" || !snapshot.model) {
        return json({ error: "bad snapshot" }, 400);
      }
      if (JSON.stringify(snapshot).length > 14000) return json({ error: "snapshot too large" }, 400);
      if (typeof forTime !== "number") return json({ error: "forTime must be a number" }, 400);

      const tf = tfOf(body);
      const m = marketOf(body);
      const key = `check:${m === "gold" ? "" : `${m}:`}${tf}:${forTime}`;
      const hit = cached<unknown>(jevCache, key, 60 * 60 * 1000);
      if (hit) return json(hit);
      let run = inflight.get(key);
      if (!run) {
        run = check(m, snapshot.data as Record<string, unknown>, snapshot.model as Record<string, unknown>, tf).then((r) => {
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
      const tf = tfOf(body);
      const m = marketOf(body);
      const key = `flip:${m === "gold" ? "" : `${m}:`}${tf}:${slotKey}`;
      const hit = cached<unknown>(jevCache, key, slotKey.startsWith("past:") ? 6 * 3600 * 1000 : 60_000);
      if (hit) return json(hit);
      let run = inflight.get(key);
      if (!run) {
        run = flip(m, state as Record<string, unknown>, tf).then((r) => {
          jevCache.set(key, { at: Date.now(), body: r });
          return r;
        });
        inflight.set(key, run);
        run.finally(() => inflight.delete(key)).catch(() => {});
      }
      return json(await run);
    }

    if (body.action === "forecast") {
      if (!env("TYPESAFE_API_KEY")) return json({ error: "TYPESAFE_API_KEY secret is not set" }, 503);
      const { data, options, forTime } = body as { data?: unknown; options?: unknown; forTime?: unknown };
      if (!data || typeof data !== "object" || JSON.stringify(data).length > 5000) return json({ error: "bad data" }, 400);
      const opts = options as Record<string, unknown> | undefined;
      const valid =
        !!opts &&
        typeof opts === "object" &&
        Object.keys(opts).length >= 2 &&
        Object.keys(opts).length <= 60 &&
        Object.entries(opts).every(([k, v]) => /^s\d{1,3}$/.test(k) && typeof v === "string" && v.length <= 120);
      if (!valid) return json({ error: "bad forecast options" }, 400);
      if (typeof forTime !== "number") return json({ error: "forTime must be a number" }, 400);
      // One pick per candle, shared by every viewer.
      const tf = tfOf(body);
      const m = marketOf(body);
      const key = `forecast:${m}:${tf}:${forTime}`;
      const hit = cached<unknown>(jevCache, key, 60 * 60 * 1000);
      if (hit) return json(hit);
      let run = inflight.get(key);
      if (!run) {
        run = forecast(m, data as Record<string, unknown>, opts as Record<string, string>, tf).then((r) => {
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
