import { useEffect, useRef, useState } from "react";
import { Swords, Shield, Search, Copy, Check, Trophy, Scroll, Coins, Skull, Sparkles, Crown } from "lucide-react";

/* ================= palette (retro medieval) ================= */
const C = {
  bg: "#14120c", panel: "#201b12", panel2: "#2b2417", border: "#4a3f28",
  ink: "#f3e9cf", muted: "#a08f6a", gold: "#e8b93b", green: "#6bd66b",
  red: "#e0483b", blue: "#5aa9e6", purple: "#b06be6",
};
const PX = "'Press Start 2P', ui-monospace, monospace";
const pixelBox = (bg: string, edge: string) => ({ background: bg, border: `3px solid ${edge}`, boxShadow: `4px 4px 0 0 #0008`, imageRendering: "pixelated" as const });
const CA = "LARP7yoUrCrYpToHer0IsACardBo4rdKn1ghtSol4nApump";

/* ================= roster (ORIGINAL larper agents) ================= */
const AGENTS = [
  { e: "🛡️", name: "Sir Cope-a-Lot", cls: "Knight", det: 88, cope: 42, fer: 72, c: C.blue, tag: "Blocks FUD, absorbs hopium." },
  { e: "🧙", name: "Wizard of Wen", cls: "Mage", det: 95, cope: 60, fer: 55, c: C.purple, tag: "Casts Detect Bagholder." },
  { e: "🏹", name: "Ranger Rug-Slayer", cls: "Archer", det: 91, cope: 50, fer: 80, c: C.green, tag: "Snipes exit liquidity at 300m." },
  { e: "🤺", name: "Duelist Due-Diligence", cls: "Fencer", det: 84, cope: 70, fer: 88, c: C.gold, tag: "Parries every 'trust me bro'." },
  { e: "🃏", name: "Jester of FUD", cls: "Bard", det: 78, cope: 92, fer: 45, c: C.red, tag: "Debuffs confidence, buffs cope." },
  { e: "👑", name: "The Exit Liquidator", cls: "King", det: 99, cope: 30, fer: 96, c: C.gold, tag: "Rules the graveyard of dead coins." },
];

const CLAIMS = ["claims 100x on a shitcoin", "says he called the exact top", "posts wins, never losses", "'been in since 2013'", "flexes a rented Lambo", "'NFA' (it was FA)", "'generational wealth incoming'", "screenshots a demo account", "'i only aped 5 figures'"];
const REALITY = ["down 38% this quarter", "bought the literal top", "wallet holds $12 and hopium", "wallet is 4 months old", "the Lambo is a Hot Wheels", "rugged his own followers", "it's a paper-trading app", "1 winning trade, 200 deleted ones", "sold the bottom, cried on stream"];
const VERDICTS = [
  { min: 0, label: "CERTIFIED REAL", e: "⚔️", c: C.green, line: "Sword's sharp. Hands are diamond. This one actually fights." },
  { min: 26, label: "MILD LARP", e: "🪵", c: C.blue, line: "Foam-sword energy. Mostly harmless, mildly delusional." },
  { min: 51, label: "HEAVY LARP", e: "🎭", c: C.gold, line: "All costume, no combat. The armor is cardboard." },
  { min: 76, label: "TOTAL LARP", e: "🤡", c: C.red, line: "Full exit-liquidity cosplay. Do NOT follow into battle." },
];
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const at = <T,>(a: T[], n: number) => a[n % a.length];

type Verdict = { handle: string; score: number; claim: string; reality: string; v: (typeof VERDICTS)[number] };

function Index() {
  const [agent, setAgent] = useState(0);
  const [handle, setHandle] = useState("");
  const [scanning, setScanning] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [copied, setCopied] = useState(false);
  const [feed, setFeed] = useState<{ id: number; h: string; s: number }[]>([]);
  const fid = useRef(1);

  useEffect(() => {
    const seed = ["@moonboy_", "@0xLarpLord", "@dev_trustme", "@100xdaily", "@chartwizard", "@rug_survivor", "@ser_pump", "@giga.eth", "@wen_lambo", "@paperhands99"];
    setFeed(seed.map((h) => ({ id: fid.current++, h, s: 30 + (hash(h) % 70) })));
    const t = setInterval(() => {
      const names = ["degen", "0x", "crypto", "ser", "moon", "chad", "ape", "gwei", "based", "giga", "wagmi", "cope"];
      const h = "@" + at(names, Math.floor(Math.random() * 999)) + at(names, Math.floor(Math.random() * 999)) + Math.floor(Math.random() * 99);
      setFeed((f) => [{ id: fid.current++, h, s: 30 + Math.floor(Math.random() * 70) }, ...f].slice(0, 10));
    }, 2600);
    return () => clearInterval(t);
  }, []);

  const scan = () => {
    const h = handle.trim().replace(/^@?/, "@") || "@anon_larper";
    setScanning(true); setVerdict(null);
    setTimeout(() => {
      const x = hash(h + AGENTS[agent].name);
      const score = x % 101;
      const v = [...VERDICTS].reverse().find((t) => score >= t.min)!;
      setVerdict({ handle: h, score, claim: at(CLAIMS, x >> 3), reality: at(REALITY, x >> 7), v });
      setScanning(false);
    }, 1900);
  };
  const copyCA = () => { navigator.clipboard?.writeText(CA).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const A = AGENTS[agent];

  return (
    <div style={{ background: C.bg, color: C.ink, minHeight: "100vh", imageRendering: "pixelated" }} className="relative overflow-hidden">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
        @keyframes bobL { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
        @keyframes bobR { 0%,100%{transform:translateY(-6px) scaleX(-1)} 50%{transform:translateY(0) scaleX(-1)} }
        @keyframes lungeL { 0%,60%,100%{transform:translateX(0)} 70%,85%{transform:translateX(38px)} }
        @keyframes lungeR { 0%,60%,100%{transform:translateX(0) scaleX(-1)} 70%,85%{transform:translateX(-38px) scaleX(-1)} }
        @keyframes spark { 0%,55%,100%{opacity:0;transform:scale(.4)} 72%{opacity:1;transform:scale(1.3)} 90%{opacity:0;transform:scale(.8)} }
        @keyframes drift { from{transform:translateX(0)} to{transform:translateX(-50%)} }
        @keyframes scanpulse { 0%,100%{transform:scale(1) rotate(-8deg)} 50%{transform:scale(1.15) rotate(8deg)} }
        @keyframes pop { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
        .bobL{animation:bobL 1.1s steps(2) infinite} .bobR{animation:bobR 1.1s steps(2) infinite}
        .lungeL{animation:lungeL 2.4s ease-in-out infinite} .lungeR{animation:lungeR 2.4s ease-in-out infinite}
        .spark{animation:spark 2.4s ease-in-out infinite} .drift{display:flex;width:max-content;animation:drift 30s linear infinite}
        .scanpulse{animation:scanpulse .7s ease-in-out infinite} .pop{animation:pop .25s steps(3)}
        .px{font-family:${PX}}
      `}</style>

      {/* ground/scanline vibe */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: `repeating-linear-gradient(0deg, ${C.ink} 0 1px, transparent 1px 4px)` }} />

      {/* ================= NAV ================= */}
      <header className="relative z-10 mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center" style={pixelBox(`linear-gradient(135deg,${C.gold},${C.red})`, C.ink)}>
            <Swords className="h-5 w-5" style={{ color: "#1a1206" }} />
          </div>
          <div>
            <div className="px text-base" style={{ color: C.gold }}>LARP&nbsp;AI</div>
            <div className="text-[10px]" style={{ color: C.muted }}>live-action larp detection</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1.5 px-2.5 py-2 text-[10px] sm:flex" style={pixelBox(C.panel, C.border)}>
            <span style={{ color: C.muted }}>$LARP</span><span style={{ color: C.green }}>+204%</span>
          </div>
          <button className="px px-3 py-2 text-[10px] transition-transform active:translate-y-0.5" style={pixelBox(`linear-gradient(135deg,${C.gold},${C.red})`, C.ink)}><span style={{ color: "#1a1206" }}>CONNECT</span></button>
        </div>
      </header>

      {/* banner */}
      <div className="relative z-10 border-y-2 py-2" style={{ borderColor: C.border, background: C.panel }}>
        <div className="drift gap-10 px-4 text-[10px]" style={{ color: C.muted }}>
          {[...Array(2)].map((_, k) => (
            <div key={k} className="flex gap-10 whitespace-nowrap">
              <span style={{ color: C.gold }}>⚔️ SEND YOUR CHAMPION · EXPOSE THE FRAUDS</span>
              <span style={{ color: C.green }}>🎭 3 MEANINGS OF LARP · 1 ARENA</span>
              <span style={{ color: C.red }}>🤡 987,412 LARPS EXPOSED</span>
              <span style={{ color: C.blue }}>🛡️ IF THE SWORD IS FOAM, WE KNOW</span>
            </div>
          ))}
        </div>
      </div>

      <main className="relative z-10 mx-auto max-w-6xl px-4 py-6">
        {/* ================= ARENA ================= */}
        <section className="relative mb-6 overflow-hidden" style={{ ...pixelBox(`linear-gradient(180deg,#1a2a3f 0%,#243b2a 62%,#2e2413 62%,#2e2413 100%)`, C.border), height: 260 }}>
          {/* castle silhouette */}
          <div className="pointer-events-none absolute bottom-[38%] left-1/2 -translate-x-1/2 opacity-40" style={{ width: 220, height: 90, background: "#0b1220" }} />
          {[[-110, 70], [-70, 90], [70, 90], [110, 70]].map(([x, h], i) => (
            <div key={i} className="pointer-events-none absolute bottom-[38%] left-1/2 opacity-40" style={{ transform: `translateX(${x}px)`, width: 26, height: h, background: "#0b1220" }} />
          ))}
          {/* fighters */}
          <div className="absolute bottom-6 left-[22%] text-6xl lungeL"><span className="bobL inline-block">{A.e}</span></div>
          <div className="absolute bottom-6 right-[22%] text-6xl lungeR"><span className="inline-block bobR">🤡</span></div>
          <div className="spark absolute bottom-16 left-1/2 -translate-x-1/2 text-4xl">💥</div>
          {/* HUD */}
          <div className="absolute left-3 top-3">
            <div className="px text-[9px]" style={{ color: C.ink }}>{A.name}</div>
            <div className="mt-1 h-3 w-28" style={pixelBox("#3a2f1c", C.border)}><div className="h-full" style={{ width: "84%", background: C.green }} /></div>
          </div>
          <div className="absolute right-3 top-3 text-right">
            <div className="px text-[9px]" style={{ color: C.ink }}>RANDOM LARPER</div>
            <div className="mt-1 ml-auto h-3 w-28" style={pixelBox("#3a2f1c", C.border)}><div className="h-full" style={{ width: "31%", background: C.red }} /></div>
          </div>
          <div className="px absolute bottom-2 left-1/2 -translate-x-1/2 text-[8px]" style={{ color: C.gold }}>⚔ ARENA · LIVE ⚔</div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,380px)]">
          {/* ================= SCANNER (the "utility") ================= */}
          <section style={pixelBox(C.panel, C.border)} className="p-5">
            <div className="px mb-1 text-sm" style={{ color: C.gold }}>THE LARP SCANNER</div>
            <p className="mb-4 text-xs" style={{ color: C.muted }}>Send <b style={{ color: A.c }}>{A.name}</b> into the arena against any crypto trader. He'll fight their claims and report back if they're the real deal… or a total larp. <span style={{ color: C.muted }}>(a "game", allegedly.)</span></p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input value={handle} onChange={(e) => setHandle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && scan()} placeholder="@crypto_handle or 0xwallet…" className="w-full px-3 py-3 text-sm outline-none" style={{ ...pixelBox(C.panel2, C.border), color: C.ink }} />
              <button onClick={scan} disabled={scanning} className="px flex items-center justify-center gap-2 px-4 py-3 text-[10px] transition-transform active:translate-y-0.5 disabled:opacity-60" style={pixelBox(`linear-gradient(135deg,${C.gold},${C.red})`, C.ink)}>
                <Search className="h-4 w-4" style={{ color: "#1a1206" }} /><span style={{ color: "#1a1206" }}>{scanning ? "FIGHTING…" : "SCAN LARP"}</span>
              </button>
            </div>

            {scanning && (
              <div className="mt-6 flex flex-col items-center justify-center gap-3 py-6">
                <div className="flex items-center gap-6 text-5xl">
                  <span className="scanpulse inline-block">{A.e}</span><span className="px text-xs" style={{ color: C.red }}>VS</span><span className="scanpulse inline-block">🤡</span>
                </div>
                <div className="px text-[10px]" style={{ color: C.muted }}>reading the tape… checking the wallet… counting the cope…</div>
              </div>
            )}

            {verdict && !scanning && (
              <div className="pop mt-5" style={pixelBox(C.panel2, verdict.v.c)}>
                <div className="flex items-center justify-between border-b-2 px-4 py-3" style={{ borderColor: C.border }}>
                  <span className="px text-xs" style={{ color: C.ink }}>{verdict.handle}</span>
                  <span className="text-2xl">{verdict.v.e}</span>
                </div>
                <div className="p-4">
                  <div className="mb-2 flex items-end justify-between">
                    <div className="px text-sm" style={{ color: verdict.v.c }}>{verdict.v.label}</div>
                    <div className="px text-2xl" style={{ color: verdict.v.c }}>{verdict.score}<span className="text-xs" style={{ color: C.muted }}>/100 larp</span></div>
                  </div>
                  <div className="mb-3 h-3 w-full" style={pixelBox("#3a2f1c", C.border)}><div className="h-full" style={{ width: `${verdict.score}%`, background: verdict.v.c }} /></div>
                  <p className="mb-3 text-xs" style={{ color: C.ink }}>{verdict.v.line}</p>
                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    <div style={pixelBox(C.panel, C.border)} className="p-2"><div className="text-[10px]" style={{ color: C.gold }}>CLAIMS</div><div style={{ color: C.muted }}>{verdict.claim}</div></div>
                    <div style={pixelBox(C.panel, C.border)} className="p-2"><div className="text-[10px]" style={{ color: C.red }}>REALITY</div><div style={{ color: C.muted }}>{verdict.reality}</div></div>
                  </div>
                </div>
              </div>
            )}
            {!verdict && !scanning && <div className="mt-6 text-center text-xs" style={{ color: C.muted }}>enter a handle and send your champion to battle ⚔️</div>}
          </section>

          {/* ================= CHARACTER SELECT ================= */}
          <aside style={pixelBox(C.panel, C.border)} className="p-4">
            <div className="px mb-3 flex items-center gap-2 text-xs" style={{ color: C.gold }}><Shield className="h-4 w-4" /> CHOOSE YOUR LARPER</div>
            <div className="grid grid-cols-2 gap-2">
              {AGENTS.map((a, i) => (
                <button key={a.name} onClick={() => setAgent(i)} className="flex flex-col items-center gap-1 p-2 text-center transition-transform active:translate-y-0.5" style={pixelBox(agent === i ? C.panel2 : C.panel, agent === i ? a.c : C.border)}>
                  <span className="text-3xl">{a.e}</span>
                  <span className="px text-[8px] leading-tight" style={{ color: agent === i ? a.c : C.ink }}>{a.name}</span>
                  <span className="text-[9px]" style={{ color: C.muted }}>{a.cls}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 p-3" style={pixelBox(C.panel2, A.c)}>
              <div className="px mb-2 text-[10px]" style={{ color: A.c }}>{A.name}</div>
              <p className="mb-2 text-[11px]" style={{ color: C.muted }}>{A.tag}</p>
              {[["LARP DETECT", A.det, C.green], ["FEROCITY", A.fer, C.red], ["COPE", A.cope, C.blue]].map(([k, v, col]) => (
                <div key={k as string} className="mb-1.5">
                  <div className="flex justify-between text-[9px]" style={{ color: C.muted }}><span>{k}</span><span>{v}</span></div>
                  <div className="h-2 w-full" style={pixelBox("#3a2f1c", C.border)}><div className="h-full" style={{ width: `${v}%`, background: col as string }} /></div>
                </div>
              ))}
            </div>
          </aside>
        </div>

        {/* ================= EXPOSED FEED ================= */}
        <section className="mt-6 p-4" style={pixelBox(C.panel, C.border)}>
          <div className="px mb-3 flex items-center gap-2 text-xs" style={{ color: C.gold }}><Skull className="h-4 w-4" /> RECENTLY EXPOSED</div>
          <div className="space-y-1.5">
            {feed.map((f) => {
              const v = [...VERDICTS].reverse().find((t) => f.s >= t.min)!;
              return (
                <div key={f.id} className="pop flex items-center justify-between px-3 py-2 text-xs" style={pixelBox(C.panel2, C.border)}>
                  <span style={{ color: C.ink }}>{f.h}</span>
                  <span className="flex items-center gap-2"><span style={{ color: C.muted }}>{v.label}</span><span className="px text-[10px]" style={{ color: v.c }}>{f.s} {v.e}</span></span>
                </div>
              );
            })}
          </div>
        </section>

        {/* ================= $LARP ================= */}
        <section className="mt-6 p-5" style={pixelBox(`linear-gradient(160deg,${C.gold}14,${C.panel})`, C.gold)}>
          <div className="px mb-3 flex items-center gap-2 text-xs" style={{ color: C.gold }}><Coins className="h-4 w-4" /> $LARP — FUND THE HUNT</div>
          <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
            <div>
              <div className="mb-1 text-[10px]" style={{ color: C.muted }}>CONTRACT (hodl or get exposed)</div>
              <button onClick={copyCA} className="mb-3 flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[11px]" style={pixelBox(C.panel2, C.border)}>
                <span className="truncate" style={{ color: C.gold }}>{CA}</span>{copied ? <Check className="h-4 w-4 shrink-0" style={{ color: C.green }} /> : <Copy className="h-4 w-4 shrink-0" style={{ color: C.muted }} />}
              </button>
              <div className="flex flex-wrap gap-2">{["pump.fun", "Uniswap", "DexScreener"].map((b) => (<a key={b} href="#" className="px px-3 py-2.5 text-[10px] transition-transform active:translate-y-0.5" style={pixelBox(`linear-gradient(135deg,${C.gold},${C.red})`, C.ink)}><span style={{ color: "#1a1206" }}>{b} →</span></a>))}</div>
            </div>
            <div className="p-3" style={pixelBox(C.panel2, C.border)}>
              <div className="px mb-2 text-[10px]" style={{ color: C.muted }}>TOKENOMICS</div>
              {[["Supply", "1,000,000,000"], ["Tax", "0% (we tax larps)"], ["Team", "1 foam sword"], ["Utility", "expose posers, number go up"]].map(([k, v]) => (
                <div key={k} className="flex justify-between border-t-2 py-1.5 text-[11px]" style={{ borderColor: C.border }}><span style={{ color: C.muted }}>{k}</span><span style={{ color: C.ink }}>{v}</span></div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= LORE (the 3 larps) ================= */}
        <section className="mt-6 grid gap-4 md:grid-cols-3">
          {[
            { i: <Swords className="h-5 w-5" />, t: "LARP #1 — The Battle", d: "Live-action role play. Foam swords, homemade armor, screaming in a field. Noble. Sweaty. We honor it." },
            { i: <Scroll className="h-5 w-5" />, t: "LARP #2 — The Poser", d: "Pretending to be someone you're not. The crypto 'genius' who's actually exit liquidity in a costume." },
            { i: <Sparkles className="h-5 w-5" />, t: "LARP #3 — The Agent", d: "Your AI champion rides out, fights their claims, and tells you which is which. That's the whole game. Wink." },
          ].map((c) => (
            <div key={c.t} className="p-5" style={pixelBox(C.panel, C.border)}>
              <div className="mb-3 grid h-10 w-10 place-items-center" style={{ ...pixelBox(C.panel2, C.border), color: C.gold }}>{c.i}</div>
              <div className="px mb-2 text-[10px]" style={{ color: C.ink }}>{c.t}</div>
              <p className="text-xs" style={{ color: C.muted }}>{c.d}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="relative z-10 mt-8 border-t-2 px-4 py-8 text-center" style={{ borderColor: C.border }}>
        <div className="px flex items-center justify-center gap-2 text-xs" style={{ color: C.gold }}><Crown className="h-4 w-4" /> LARP AI</div>
        <p className="mx-auto mt-3 max-w-2xl text-[10px]" style={{ color: C.muted }}>
          Parody. For the memes. LARP AI is an entertainment toy — the "larp scores" are randomized jokes, not real analysis of any real person or wallet, and $LARP is a valueless meme token. Nothing here is financial advice, due diligence, or an accusation about anyone real. Go outside and hit someone with a foam sword instead. ⚔️
        </p>
      </footer>
    </div>
  );
}

export default Index;
