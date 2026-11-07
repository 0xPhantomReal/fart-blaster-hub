import { useEffect, useMemo, useState } from "react";
import { lightspeedCore } from "./lightspeedCore";
import { fetchLightspeed, type Market } from "./feed";

const MUTED = "text-[#8b949e]";
const GREEN = "text-[#26a69a]";
const RED = "text-[#ef5350]";

type C = { time: number; open: number; high: number; low: number; close: number };
type Obj = Record<string, unknown>;

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Obj)[k] : undefined), o);
const signed = (v: number | null, d = 2, unit = "") =>
  v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}${unit}`;
const tone = (v: number | null, dead = 0) => (v === null || Math.abs(v) <= dead ? MUTED : v > 0 ? GREEN : RED);

function Row({ label, value, cls, hint }: { label: string; value: string; cls?: string; hint?: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs" title={hint}>
      <span className={`truncate ${MUTED}`}>{label}</span>
      <span className={`whitespace-nowrap font-mono ${cls ?? ""}`}>{value}</span>
    </div>
  );
}

/** Lightspeed V0.5: what Jev sees on every call — the candle math (computed here) and the live market block. */
export function LightspeedPanel({
  market,
  tfMin,
  closed,
  forming,
  enabled,
}: {
  market: Market;
  tfMin: number;
  closed: C[];
  forming: C | null;
  enabled: boolean;
}) {
  const tf = tfMin * 60;
  const [live, setLive] = useState<Obj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const load = async () => {
      try {
        const r = await fetchLightspeed(market, tfMin);
        if (!stop) {
          setLive(r.live);
          setErr(null);
        }
      } catch (e) {
        if (!stop) setErr((e as Error).message);
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [market, tfMin, enabled]);

  const f = forming && forming.time + tf > Date.now() / 1000 ? forming : null;
  const t = f ? f.time : closed.length ? closed[closed.length - 1].time + tf : 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const core = useMemo(() => (t ? lightspeedCore(closed, t, tf, f ? Date.now() / 1000 - t : 0, f) : null), [closed, f?.close, f?.high, f?.low, t, tf, Math.floor(tick / 2)]);

  if (!enabled) {
    return (
      <div className={`text-xs ${MUTED}`}>
        Lightspeed V0.5: waiting for the gold edge function (redeploy it to turn on the live market block).
      </div>
    );
  }

  const fp = get(core, "finish_probability");
  const pRw = n(get(fp, "random_walk_p_green_pct"));
  const cb = get(live, "coinbase_order_book");
  const kr = get(live, "kraken_order_book");
  const flow = get(live, "coinbase_trade_flow_now");
  const hl = get(live, "hyperliquid_perp");
  const db = get(live, "deribit_perp");
  const ven = get(live, "brti_venues");
  const pm = get(live, "polymarket_crowd");
  const others = get(live, "other_coins") as Obj | undefined;
  const buy30 = n(get(flow, "last_30s", "buy_share_pct"));

  return (
    <div className="rounded border border-[#30363d] bg-[#0d1117] p-3">
      <div className="mb-2">
        <div className="whitespace-nowrap text-sm font-semibold tracking-wide">
          Lightspeed <span className="text-[#58a6ff]">V0.5</span>
        </div>
        <div className={`text-[11px] ${MUTED}`}>what Jev sees on every call</div>
      </div>

      <div className="mb-2">
        <div className="mb-1 flex items-baseline gap-2">
          <div className={`font-mono text-2xl ${pRw === null ? MUTED : pRw >= 50 ? GREEN : RED}`}>
            {pRw === null ? "—" : `${pRw.toFixed(0)}%`}
          </div>
          <div className={`text-[11px] ${MUTED}`}>chance of green if price random-walks from here</div>
        </div>
        <div className="space-y-0.5">
          <Row label="Time left" value={n(get(fp, "seconds_left")) === null ? "—" : `${n(get(fp, "seconds_left"))} s`} />
          <Row label="Move so far" value={signed(n(get(fp, "move_dollars")), 2, " $")} cls={tone(n(get(fp, "move_dollars")))} />
          <Row label="Typical move" value={`±${n(get(fp, "typical_move_in_time_left_dollars"))?.toFixed(2) ?? "—"} $`} />
          <Row
            label="Last 48"
            value={`${n(get(core, "base_rates", "green_pct_last_48"))?.toFixed(0) ?? "—"}% green · ac ${signed(n(get(core, "serial_dependence", "lag1_autocorrelation")), 2)}`}
            hint="Green share of the last 48 candles; ac = candle-to-candle autocorrelation (below 0 = moves have been reversing)"
          />
          <Row
            hint="Per-candle volatility, and how it compares with the last day"
            label="Volatility"
            value={`${n(get(core, "volatility", "per_candle_pct"))?.toFixed(3) ?? "—"}% · ×${n(get(core, "volatility", "regime_vs_last_day"))?.toFixed(2) ?? "—"}`}
          />
        </div>
      </div>

      <div className="space-y-0.5 border-t border-[#30363d] pt-2">
        <Row label="Coinbase book" value={signed(n(get(cb, "imbalance_within_25bps")), 2)} cls={tone(n(get(cb, "imbalance_within_25bps")), 0.05)} hint="+ = more bids than asks near the price" />
        <Row label="Micro-price" value={signed(n(get(cb, "microprice_offset_bps")), 2, " bps")} cls={tone(n(get(cb, "microprice_offset_bps")), 0.01)} />
        <Row label="Kraken book" value={signed(n(get(kr, "imbalance_within_25bps")), 2)} cls={tone(n(get(kr, "imbalance_within_25bps")), 0.05)} />
        <Row label="Buys, last 30 s" value={buy30 === null ? "—" : `${buy30.toFixed(0)}%`} cls={buy30 === null ? MUTED : tone(buy30 - 50, 5)} />
        <Row label="Hyperliquid perp" value={signed(n(get(hl, "perp_vs_spot_bps")), 1, " bps")} cls={tone(n(get(hl, "perp_vs_spot_bps")), 1)} />
        <Row label="Deribit perp" value={signed(n(get(db, "perp_vs_index_bps")), 1, " bps")} cls={tone(n(get(db, "perp_vs_index_bps")), 1)} />
        <Row label="Venue spread" hint={`BRTI venues: highest ${String(get(ven, "highest") ?? "—")}, lowest ${String(get(ven, "lowest") ?? "—")}`} value={`${n(get(ven, "spread_between_venues_bps"))?.toFixed(1) ?? "—"} bps`} />
        {others &&
          Object.entries(others).map(([k, v]) => {
            const x = n(get(v, "move_since_candle_open_pct"));
            return <Row key={k} label={`${k.toUpperCase()} this candle`} value={signed(x, 3, "%")} cls={tone(x)} />;
          })}
        {pm ? (
          <Row label="Polymarket crowd" value={`${n(get(pm, "implied_p_up_pct"))?.toFixed(0) ?? "—"}% up`} />
        ) : null}
        <Row label="Clock" value={`${String(get(core, "clock", "session") ?? "—")}${get(core, "clock", "turn_of_15m_candle") ? " · 15m turn" : ""}`} />
      </div>
      {err && <div className={`mt-1 text-[11px] ${MUTED}`}>live block: {err}</div>}
    </div>
  );
}
