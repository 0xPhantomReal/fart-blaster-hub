import { useEffect, useRef, useState } from "react";

function Index() {
  const [brandImg, setBrandImg] = useState(true);
  const sceneRef = useRef<HTMLDivElement>(null);
  const poolRef = useRef<HTMLDivElement>(null);
  const dunkRef = useRef<HTMLSpanElement>(null);
  const muteRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const scene = sceneRef.current, pool = poolRef.current, dunkEl = dunkRef.current, muteBtn = muteRef.current;
    if (!scene || !pool) return;
    const IMG = "/nugget-chicken.png";
    let imgOk = false, dunked = 0, active = 0, muted = true;
    const SPLATS = ["PLORP!", "SPLAT!", "BLORP!", "GLOOP!", "SPLOOSH!", "DIP!", "SPLONK!"];
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));

    const probe = new Image(); probe.onload = () => { imgOk = true; }; probe.src = IMG;

    let actx: AudioContext | null = null;
    const ctx = () => { if (!actx) { try { actx = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch { return null; } } if (actx && actx.state === "suspended") actx.resume(); return actx; };
    const blorp = () => {
      if (muted) return; const c = ctx(); if (!c) return; const t = c.currentTime;
      const o = c.createOscillator(), g = c.createGain(); o.type = "sine";
      o.frequency.setValueAtTime(420, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.14);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.22);
      const dur = 0.09, buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const n = c.createBufferSource(); n.buffer = buf; const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900;
      const ng = c.createGain(); ng.gain.setValueAtTime(0.18, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      n.connect(f).connect(ng).connect(c.destination); n.start(t); n.stop(t + dur);
    };

    const splash = (x: number) => {
      const poolTop = window.innerHeight - pool.offsetHeight + 24;
      const s = document.createElement("div"); s.className = "splat"; s.style.left = x + "px"; s.style.top = poolTop + "px";
      s.style.fontSize = (16 + Math.random() * 14) + "px"; s.textContent = SPLATS[Math.floor(Math.random() * SPLATS.length)];
      scene.appendChild(s); later(() => s.remove(), 720);
      for (let i = 0; i < 6; i++) {
        const dp = document.createElement("div"); dp.className = "drop";
        const dx = (Math.random() * 2 - 1) * 70, dy = -(20 + Math.random() * 50), sz = 6 + Math.random() * 8;
        dp.style.left = x + "px"; dp.style.top = poolTop + "px"; dp.style.width = dp.style.height = sz + "px"; dp.style.transform = "translate(-50%,-50%)";
        scene.appendChild(dp);
        requestAnimationFrame(() => { dp.style.transition = "transform .55s cubic-bezier(.2,.7,.3,1), opacity .55s"; dp.style.transform = "translate(" + (dx - 5) + "px," + dy + "px)"; dp.style.opacity = "0"; });
        later(() => dp.remove(), 600);
      }
      blorp(); dunked++; if (dunkEl) dunkEl.textContent = dunked.toLocaleString();
    };

    const spawn = (x?: number) => {
      if (active > 34) return;
      const size = 46 + Math.random() * 54;
      const px = (x == null ? Math.random() * (window.innerWidth - size) : Math.max(0, Math.min(window.innerWidth - size, x - size / 2)));
      const el = document.createElement("div"); el.className = "chick";
      el.style.width = size + "px"; el.style.height = size + "px"; el.style.left = px + "px";
      if (imgOk) { const im = document.createElement("img"); im.src = IMG; im.alt = "nugget chicken"; el.appendChild(im); }
      else { const sp = document.createElement("div"); sp.className = "emoji"; sp.style.fontSize = size + "px"; sp.textContent = "🍗"; el.appendChild(sp); }
      const fall = window.innerHeight - (pool.offsetHeight - 30) + 40;
      el.style.setProperty("--fall", fall + "px"); el.style.setProperty("--spin", ((Math.random() * 2 - 1) * 220) + "deg");
      el.style.animation = "fall " + (3 + Math.random() * 2.6) + "s cubic-bezier(.45,.05,.75,.6) forwards";
      let finished = false;
      const done = (atX?: number) => { if (finished) return; finished = true; active--; splash(atX != null ? atX : (px + size / 2)); el.remove(); };
      el.addEventListener("pointerdown", (e) => { e.stopPropagation(); const r = el.getBoundingClientRect(); done(r.left + r.width / 2); });
      el.addEventListener("animationend", () => done());
      scene.appendChild(el); active++;
    };
    const rain = (n = 14) => { for (let i = 0; i < n; i++) later(() => spawn(), i * 70); };

    const onScene = (e: PointerEvent) => { const t = e.target as HTMLElement; if (t.closest(".brand") || t.closest("#mute")) return; spawn(e.clientX); };
    scene.addEventListener("pointerdown", onScene);
    const rainBtn = scene.querySelector<HTMLButtonElement>("#rainBtn");
    if (rainBtn) rainBtn.onclick = () => rain(16);
    if (muteBtn) muteBtn.onclick = () => { muted = !muted; muteBtn.textContent = muted ? "🔇" : "🔊"; if (!muted) blorp(); };
    document.querySelectorAll<HTMLButtonElement>(".buy-rain").forEach((b) => (b.onclick = () => rain(14)));
    const buyBtn = document.getElementById("buyBtn");
    if (buyBtn) buyBtn.onclick = () => document.getElementById("more")?.scrollIntoView({ behavior: "smooth" });
    const caBtn = document.getElementById("ca");
    if (caBtn) caBtn.onclick = () => { navigator.clipboard?.writeText("NUGG7yoUrCh1ckenIsAlreadyFr1edSol4nApumpKetchUp").catch(() => {}); const ico = document.getElementById("caIco"); if (ico) { ico.textContent = "✅"; later(() => (ico.textContent = "📋"), 1400); } };

    const amb = window.setInterval(() => spawn(), 720); timers.push(amb);
    for (let i = 0; i < 6; i++) later(() => spawn(), i * 260);

    return () => { timers.forEach(clearTimeout); clearInterval(amb); scene.removeEventListener("pointerdown", onScene); scene.querySelectorAll(".chick,.splat,.drop").forEach((n) => n.remove()); };
  }, []);

  return (
    <>
      <style>{`
        :root{ --ketchup:#cf1c0e; --ketchup2:#8f120a; --shine:#ff6a58; --gold:#ffcb3b; --cream:#fff4df; --oil1:#1b1206; --oil2:#3a2610; }
        body{ font-family:'Segoe UI',system-ui,sans-serif; color:var(--cream); background:radial-gradient(120% 90% at 50% -10%, #5a3c14 0%, var(--oil2) 40%, var(--oil1) 100%); overflow-x:hidden; margin:0; }
        #scene{ position:relative; height:100vh; overflow:hidden; cursor:crosshair; }
        .grease{ position:absolute; inset:0; pointer-events:none; opacity:.5; background:radial-gradient(60% 40% at 20% 15%, #ffd77a22, transparent 60%), radial-gradient(50% 40% at 80% 25%, #ffb03322, transparent 60%); }
        .chick{ position:absolute; top:-140px; will-change:transform; pointer-events:auto; user-select:none; filter:drop-shadow(0 6px 10px #0007); }
        .chick img,.chick .emoji{ display:block; width:100%; height:100%; }
        .chick .emoji{ line-height:1; text-align:center; }
        @keyframes fall{ to{ transform:translateY(var(--fall)) rotate(var(--spin)); } }
        #hud{ position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:flex-start; padding-top:6vh; text-align:center; pointer-events:none; z-index:5; }
        .brand{ pointer-events:auto; background:#1a120699; border:3px solid var(--gold); border-radius:22px; padding:18px 26px; box-shadow:0 10px 40px #000a, inset 0 0 0 2px #0006; backdrop-filter:blur(2px); max-width:min(92vw,720px); animation:wob 4s ease-in-out infinite; }
        @keyframes wob{ 0%,100%{ transform:rotate(-1.2deg) } 50%{ transform:rotate(1.2deg) } }
        .brand h1{ font-size:clamp(34px,8vw,74px); font-weight:900; letter-spacing:-1px; line-height:.95; color:var(--gold); text-shadow:3px 3px 0 #7a3d00, 0 0 22px #ffb03388; margin:0; }
        .brand h1 span{ color:var(--ketchup); text-shadow:3px 3px 0 #4a0a06; }
        .brand p{ margin:10px 0 0; font-size:clamp(13px,2.4vw,17px); color:#ffe8c2; }
        .btns{ margin-top:14px; display:flex; gap:10px; flex-wrap:wrap; justify-content:center; }
        button.b{ pointer-events:auto; font-weight:900; font-size:14px; border:none; border-radius:14px; padding:12px 18px; cursor:pointer; transition:transform .08s; box-shadow:0 5px 0 #0006; color:#2a1500; }
        button.b:active{ transform:translateY(4px); box-shadow:0 1px 0 #0006; }
        .b-rain{ background:linear-gradient(135deg,var(--gold),#ff8a2b); }
        .b-buy{ background:linear-gradient(135deg,var(--ketchup),var(--shine)); color:#fff; }
        .counter{ margin-top:12px; font-weight:800; font-size:13px; color:#ffd98a; pointer-events:auto; }
        .counter b{ color:var(--gold); font-size:16px; }
        #mute{ position:absolute; top:14px; right:14px; z-index:7; pointer-events:auto; width:42px; height:42px; border-radius:12px; border:2px solid #ffffff33; background:#1a120699; color:var(--gold); font-size:18px; cursor:pointer; }
        #pool{ position:absolute; left:0; right:0; bottom:0; height:150px; z-index:4; pointer-events:none; }
        .pool-body{ position:absolute; inset:0; top:26px; background:linear-gradient(180deg,var(--ketchup) 0%,var(--ketchup2) 100%); box-shadow:inset 0 8px 24px #ff9a8a55, inset 0 -20px 40px #4a0a06; animation:bob 3.5s ease-in-out infinite; }
        @keyframes bob{ 0%,100%{ transform:translateY(0) } 50%{ transform:translateY(4px) } }
        .pool-wave{ position:absolute; left:-2%; right:-2%; top:0; height:44px; }
        .pool-shine{ position:absolute; left:6%; top:34px; width:32%; height:8px; background:#ff8f7e88; filter:blur(3px); border-radius:50%; }
        .splat{ position:absolute; transform:translate(-50%,-50%); font-weight:900; color:#fff; text-shadow:2px 2px 0 var(--ketchup2); pointer-events:none; animation:splat .7s ease-out forwards; z-index:6; }
        @keyframes splat{ 0%{ opacity:0; transform:translate(-50%,-50%) scale(.4) } 25%{ opacity:1; transform:translate(-50%,-70%) scale(1.15) } 100%{ opacity:0; transform:translate(-50%,-120%) scale(1) } }
        .drop{ position:absolute; border-radius:50%; background:var(--ketchup); pointer-events:none; z-index:5; }
        #more{ position:relative; z-index:3; padding:40px 16px 60px; }
        .wrap{ max-width:900px; margin:0 auto; }
        .card{ background:#1a1206; border:3px solid #4a3418; border-radius:20px; padding:22px; box-shadow:0 10px 30px #0006; }
        .row{ display:grid; gap:16px; }
        @media(min-width:760px){ .row2{ grid-template-columns:1.4fr 1fr; } .row3{ grid-template-columns:repeat(3,1fr); } }
        h2{ color:var(--gold); font-size:22px; margin:0 0 12px; }
        .ca{ display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; background:#0f0b04; border:2px solid #4a3418; border-radius:12px; padding:12px 14px; font-family:ui-monospace,monospace; font-size:12px; color:var(--gold); cursor:pointer; }
        .tok div{ display:flex; justify-content:space-between; border-top:2px solid #33260f; padding:8px 0; font-size:13px; color:#c9b48a; }
        .tok b{ color:var(--cream); }
        .buys{ display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
        .lore .card{ text-align:center; }
        .lore .em{ font-size:40px; }
        .foot{ text-align:center; font-size:11px; color:#8a744a; max-width:640px; margin:26px auto 0; line-height:1.6; }
      `}</style>

      <section id="scene" ref={sceneRef}>
        <div className="grease" />
        <button id="mute" ref={muteRef} title="unmute the blorps">🔇</button>
        <div id="hud">
          <div className="brand">
            {brandImg ? (
              <img
                src="/nugget-chicken.png"
                alt="Chicken Nugget"
                onError={() => setBrandImg(false)}
                style={{ display: "block", margin: "0 auto", width: "min(66vw,280px)", height: "auto", filter: "drop-shadow(0 8px 16px #000a)" }}
              />
            ) : (
              <h1>CHICKEN <span>NUGGET</span></h1>
            )}
            <p>A chicken. Made entirely out of a chicken nugget. It's raining them into ketchup. Don't ask questions. 🍗</p>
            <div className="btns">
              <button className="b b-rain" id="rainBtn">🍗 MAKE IT RAIN</button>
              <button className="b b-buy" id="buyBtn">🍅 BUY $NUGGET</button>
            </div>
            <div className="counter">🥫 <b><span ref={dunkRef}>0</span></b> nuggets dunked · click the sky to drop more</div>
          </div>
        </div>
        <div id="pool" ref={poolRef}>
          <svg className="pool-wave" viewBox="0 0 100 12" preserveAspectRatio="none">
            <path d="M0,6 Q6,1 12,6 T24,6 T36,6 T48,6 T60,6 T72,6 T84,6 T96,6 T108,6 V12 H0 Z" fill="var(--ketchup)" />
          </svg>
          <div className="pool-body" />
          <div className="pool-shine" />
        </div>
      </section>

      <section id="more">
        <div className="wrap">
          <div className="card" style={{ background: "linear-gradient(160deg,#cf1c0e18,#1a1206)", borderColor: "#5a3418" }}>
            <h2>🍅 $NUGGET</h2>
            <div className="row row2">
              <div>
                <div style={{ fontSize: 11, color: "#a88f5f", marginBottom: 6 }}>CONTRACT ADDRETH (dip responthibly)</div>
                <div className="ca" id="ca"><span id="caTxt">NUGG7yoUrCh1ckenIsAlreadyFr1edSol4nApumpKetchUp</span><span id="caIco">📋</span></div>
                <div className="buys">
                  <button className="b b-rain buy-rain">pump.fun →</button>
                  <button className="b b-rain buy-rain">Raydium →</button>
                  <button className="b b-rain buy-rain">DexScreener →</button>
                </div>
              </div>
              <div className="card tok" style={{ padding: 14, borderColor: "#4a3418" }}>
                <div style={{ fontSize: 11, color: "#a88f5f", border: 0 }}>TOKENOMICTH</div>
                <div><span>Supply</span><b>1,000,000,000</b></div>
                <div><span>Tax</span><b>0% (already deep fried)</b></div>
                <div><span>Team</span><b>1 dipping sauce</b></div>
                <div><span>Utility</span><b>falls into ketchup</b></div>
              </div>
            </div>
          </div>
          <div className="row row3 lore" style={{ marginTop: 16 }}>
            <div className="card"><div className="em">🐔</div><h3 style={{ color: "var(--gold)", margin: "8px 0 6px", fontSize: 14 }}>Is it a chicken?</h3><p style={{ fontSize: 13, color: "#c9b48a", margin: 0 }}>Yes. Head, wattle, legs, the whole vibe. Struts around. Clucks, allegedly.</p></div>
            <div className="card"><div className="em">🍗</div><h3 style={{ color: "var(--gold)", margin: "8px 0 6px", fontSize: 14 }}>Is it a nugget?</h3><p style={{ fontSize: 13, color: "#c9b48a", margin: 0 }}>Also yes. Body is 100% breaded, golden, crispy. It was born fried. A miracle.</p></div>
            <div className="card"><div className="em">🥫</div><h3 style={{ color: "var(--gold)", margin: "8px 0 6px", fontSize: 14 }}>Why the ketchup?</h3><p style={{ fontSize: 13, color: "#c9b48a", margin: 0 }}>Every nugget must fulfill its destiny. It's not sad. It's dipping. Respect the dip.</p></div>
          </div>
          <p className="foot">Parody. For the memes. A nonsense site about a fictional deep-fried chicken. No real chickens were dipped. $NUGGET is a valueless joke token — no team, no roadmap, no utility beyond falling into condiments. Nothing here is financial advice. Now go make it rain. 🍗🍅</p>
        </div>
      </section>
    </>
  );
}

export default Index;
