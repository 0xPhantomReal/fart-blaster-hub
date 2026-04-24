import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import logo from "@/assets/fart-blaster-logo.png";
import banner from "@/assets/fart-blaster-banner.png";
import FartCloud from "@/components/FartCloud";
import FloatingFarts from "@/components/FloatingFarts";
import Marquee from "@/components/Marquee";

const CONTRACT = "FART420BL4ST3R3000xPuMpKtSoLaNaM3M3C0iN";

const Index = () => {
  const [fartCount, setFartCount] = useState(420690);
  const [shaking, setShaking] = useState(false);

  const blast = () => {
    setFartCount((c) => c + Math.floor(Math.random() * 100) + 1);
    setShaking(true);
    setTimeout(() => setShaking(false), 400);
    const sounds = ["💨 PFFFFT!", "🌬️ BRAAAAP!", "💩 TOOT TOOT!", "💚 RIIIIIP!", "🚀 BLASTOFF!"];
    toast(sounds[Math.floor(Math.random() * sounds.length)], {
      style: {
        background: "hsl(85 95% 55%)",
        color: "hsl(270 60% 8%)",
        border: "4px solid hsl(270 60% 8%)",
        fontWeight: 900,
        fontSize: "1.2rem",
      },
    });
  };

  const copyContract = () => {
    navigator.clipboard.writeText(CONTRACT);
    toast("📋 CONTRACT COPIED — NOW FART RESPONSIBLY", {
      style: {
        background: "hsl(340 90% 60%)",
        color: "white",
        border: "4px solid hsl(270 60% 8%)",
        fontWeight: 900,
      },
    });
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <FloatingFarts />

      {/* NAV */}
      <nav className="relative z-20 flex items-center justify-between px-6 md:px-12 py-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-toxic shadow-toxic flex items-center justify-center text-2xl border-4 border-background">
            💩
          </div>
          <span className="comic text-2xl md:text-3xl text-primary">FART BLASTER 3000</span>
        </div>
        <div className="hidden md:flex items-center gap-6 comic text-xl">
          <a href="#about" className="text-foreground hover:text-primary transition-colors">ABOUT</a>
          <a href="#tokenomics" className="text-foreground hover:text-primary transition-colors">TOKENOMICS</a>
          <a href="#roadmap" className="text-foreground hover:text-primary transition-colors">ROADMAP</a>
          <a href="#how" className="text-foreground hover:text-primary transition-colors">HOW TO BUY</a>
        </div>
        <Button
          onClick={copyContract}
          className="bg-accent hover:bg-accent/90 text-accent-foreground comic text-lg border-4 border-background shadow-hard hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all"
        >
          BUY $FART
        </Button>
      </nav>

      {/* HERO */}
      <section className="relative z-10 px-6 md:px-12 pt-8 pb-20">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8 relative">
            <div className="inline-block bg-accent border-4 border-background px-4 py-2 -rotate-3 shadow-hard">
              <span className="comic text-lg text-accent-foreground">⚠️ HIGHLY VOLATILE & VERY GASSY</span>
            </div>

            <h1 className="display text-6xl md:text-8xl leading-none">
              <span className="block text-primary text-stroke-thick">FART</span>
              <span className="block text-secondary text-stroke-thick -mt-2">BLASTER</span>
              <span className="block text-accent text-stroke-thick -mt-2 text-7xl md:text-9xl">3000</span>
            </h1>

            <p className="text-xl md:text-2xl font-bold max-w-lg">
              The meme that <span className="text-primary underline decoration-wavy">RIPS</span>.
              No utility. No promises. Just <span className="text-accent">cosmic flatulence</span> and
              <span className="text-secondary"> generational gains</span>.
            </p>

            <div className="flex flex-wrap gap-4">
              <Button
                onClick={blast}
                size="lg"
                className={`bg-toxic text-background comic text-2xl px-8 py-7 border-4 border-background shadow-hard hover:shadow-toxic transition-all ${shaking ? "animate-shake" : ""}`}
              >
                💨 PULL THE TRIGGER
              </Button>
              <Button
                onClick={copyContract}
                size="lg"
                variant="outline"
                className="bg-card border-4 border-primary text-primary comic text-2xl px-8 py-7 shadow-hard hover:bg-primary hover:text-background transition-all"
              >
                📋 COPY CA
              </Button>
            </div>

            <div className="bg-card border-4 border-primary rounded-2xl p-4 shadow-toxic">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-xs comic text-muted-foreground">GLOBAL FART COUNTER</div>
                  <div className="comic text-3xl md:text-4xl text-primary">
                    {fartCount.toLocaleString()} 💨
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs comic text-muted-foreground">METHANE LEVEL</div>
                  <div className="comic text-3xl md:text-4xl text-accent">CRITICAL 🔥</div>
                </div>
              </div>
            </div>
          </div>

          {/* Logo art */}
          <div className="relative">
            <div className="absolute inset-0 bg-toxic blur-3xl opacity-30 rounded-full" />
            <img
              src={logo}
              alt="Fart Blaster 3000 Logo"
              className={`relative z-10 w-full max-w-xl mx-auto rounded-3xl border-4 border-background shadow-cosmic ${shaking ? "animate-shake" : "animate-float-fart"}`}
            />
            <div className="absolute -top-6 -left-6 animate-wiggle">
              <FartCloud size={100} />
            </div>
            <div className="absolute -bottom-4 -right-4 animate-float-fart" style={{ animationDelay: "1s" }}>
              <FartCloud size={120} />
            </div>
          </div>
        </div>
      </section>

      <Marquee />

      {/* ABOUT */}
      <section id="about" className="relative z-10 px-6 md:px-12 py-20">
        <div className="max-w-6xl mx-auto">
          <h2 className="display text-5xl md:text-7xl text-center mb-4 text-primary text-stroke-thick">
            WHAT IS THIS NONSENSE?
          </h2>
          <p className="text-center comic text-2xl text-muted-foreground mb-16">
            (a very serious financial instrument)
          </p>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                emoji: "🚀",
                title: "TOOT TO THE MOON",
                desc: "Propulsion powered exclusively by community methane. NASA approved (citation needed).",
                color: "primary",
                rotate: "-rotate-2",
              },
              {
                emoji: "💩",
                title: "NO UTILITY",
                desc: "Just farts. We don't pretend to be solving real problems. Refreshing, isn't it?",
                color: "accent",
                rotate: "rotate-2",
              },
              {
                emoji: "👃",
                title: "BUILT DIFFERENT",
                desc: "Diamond hands? More like diamond cheeks. Hold tight, squeeze tighter.",
                color: "secondary",
                rotate: "-rotate-1",
              },
            ].map((card, i) => (
              <div
                key={i}
                className={`bg-card border-4 border-background rounded-3xl p-8 shadow-hard hover:shadow-toxic transition-all hover:-translate-y-2 ${card.rotate}`}
              >
                <div className="text-6xl mb-4">{card.emoji}</div>
                <h3 className={`display text-3xl mb-3 text-${card.color}`}>{card.title}</h3>
                <p className="text-lg">{card.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* BANNER STRIP */}
      <section className="relative z-10 px-6 md:px-12 py-10">
        <div className="max-w-7xl mx-auto">
          <img
            src={banner}
            alt="Fart Blaster 3000 Cosmic Banner"
            className="w-full rounded-3xl border-4 border-background shadow-cosmic"
          />
        </div>
      </section>

      {/* TOKENOMICS */}
      <section id="tokenomics" className="relative z-10 px-6 md:px-12 py-20">
        <div className="max-w-6xl mx-auto">
          <h2 className="display text-5xl md:text-7xl text-center mb-16 text-accent text-stroke-thick">
            FARTONOMICS 💨📊
          </h2>

          <div className="grid md:grid-cols-2 gap-8 items-center">
            <div className="space-y-4">
              {[
                { label: "TOTAL SUPPLY", value: "1,000,000,000", emoji: "💩", color: "primary" },
                { label: "LIQUIDITY POOL", value: "BURNED 🔥", emoji: "🔥", color: "accent" },
                { label: "TAX", value: "0/0 (FREE FARTS)", emoji: "🆓", color: "secondary" },
                { label: "CONTRACT", value: "RENOUNCED", emoji: "✅", color: "primary" },
                { label: "TEAM TOKENS", value: "0% (WE'RE BROKE)", emoji: "🥲", color: "accent" },
              ].map((item, i) => (
                <div
                  key={i}
                  className="bg-card border-4 border-background rounded-2xl p-5 flex items-center justify-between shadow-hard hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{item.emoji}</span>
                    <span className="comic text-xl">{item.label}</span>
                  </div>
                  <span className={`comic text-xl text-${item.color}`}>{item.value}</span>
                </div>
              ))}
            </div>

            {/* The Blaster Stats */}
            <div className="relative bg-cosmic border-4 border-primary rounded-3xl p-8 shadow-toxic stars-bg">
              <div className="text-center mb-6">
                <div className="comic text-2xl text-primary mb-2">METHANE PRESSURE GAUGE</div>
                <div className="display text-7xl text-accent text-stroke-thick">∞ PSI</div>
              </div>

              <div className="space-y-3">
                {[
                  { label: "Stinkiness", val: 99 },
                  { label: "Moon Velocity", val: 88 },
                  { label: "Diamond Cheeks", val: 100 },
                  { label: "Utility", val: 0 },
                ].map((stat, i) => (
                  <div key={i}>
                    <div className="flex justify-between comic text-base mb-1">
                      <span>{stat.label}</span>
                      <span className="text-primary">{stat.val}%</span>
                    </div>
                    <div className="h-4 bg-background rounded-full overflow-hidden border-2 border-primary">
                      <div
                        className="h-full bg-toxic animate-pulse-toxic"
                        style={{ width: `${stat.val}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Contract address */}
          <div
            onClick={copyContract}
            className="mt-12 bg-card border-4 border-dashed border-primary rounded-2xl p-6 cursor-pointer hover:bg-muted transition-all group"
          >
            <div className="comic text-lg text-muted-foreground mb-2">📜 CONTRACT ADDRESS (CLICK TO COPY)</div>
            <div className="font-mono text-sm md:text-lg text-primary break-all group-hover:text-accent transition-colors">
              {CONTRACT}
            </div>
          </div>
        </div>
      </section>

      {/* ROADMAP */}
      <section id="roadmap" className="relative z-10 px-6 md:px-12 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="display text-5xl md:text-7xl text-center mb-16 text-secondary text-stroke-thick">
            THE FARTMAP 🗺️
          </h2>

          <div className="space-y-6">
            {[
              { phase: "PHASE 1", title: "INITIAL EMISSION", desc: "Launch on Solana. First fart heard 'round the world. CTO formed in a Discord voice chat at 3AM.", status: "✅ DONE" },
              { phase: "PHASE 2", title: "GAS BUILDUP", desc: "List on DexScreener. Trending on pump.fun. Twitter raid armies form. CT influencers shill for free fart juice.", status: "🔄 ACTIVE" },
              { phase: "PHASE 3", title: "CRITICAL PRESSURE", desc: "CEX listings. Billboard in Times Square (the small one). Fart Blaster plushies. Real-life fart-powered Tesla.", status: "🔜 SOON" },
              { phase: "PHASE 4", title: "FULL BLAST", desc: "Toot heard on the moon. Powell announces FART as new reserve currency. Universe collapses into a single, magnificent rip.", status: "🌌 INEVITABLE" },
            ].map((item, i) => (
              <div
                key={i}
                className={`bg-card border-4 border-background rounded-3xl p-6 md:p-8 shadow-hard relative ${i % 2 === 0 ? "md:ml-0 md:mr-12" : "md:ml-12 md:mr-0"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4 mb-3">
                  <div>
                    <div className="comic text-sm text-muted-foreground">{item.phase}</div>
                    <h3 className="display text-3xl md:text-4xl text-primary">{item.title}</h3>
                  </div>
                  <span className="comic text-lg bg-secondary text-secondary-foreground px-4 py-1 rounded-full border-2 border-background">
                    {item.status}
                  </span>
                </div>
                <p className="text-lg">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW TO BUY */}
      <section id="how" className="relative z-10 px-6 md:px-12 py-20">
        <div className="max-w-6xl mx-auto">
          <h2 className="display text-5xl md:text-7xl text-center mb-16 text-primary text-stroke-thick">
            HOW TO RIP 💨
          </h2>

          <div className="grid md:grid-cols-4 gap-6">
            {[
              { n: "01", title: "GET A WALLET", desc: "Download Phantom or Solflare. Don't lose your seed phrase or we WILL laugh.", emoji: "👛" },
              { n: "02", title: "FUND IT", desc: "Buy SOL on any exchange. Send it to your wallet. Pray to the gas gods.", emoji: "💰" },
              { n: "03", title: "SWAP FOR FART", desc: "Head to Jupiter or Raydium. Paste the contract. Confirm. Inhale deeply.", emoji: "🔄" },
              { n: "04", title: "HODL & RIP", desc: "Diamond cheeks only. Sell and we toot at your funeral. Welcome to the FARTOLUTION.", emoji: "💎" },
            ].map((step, i) => (
              <div
                key={i}
                className="relative bg-card border-4 border-background rounded-3xl p-6 shadow-hard hover:shadow-toxic hover:-translate-y-2 transition-all"
              >
                <div className="absolute -top-5 -left-3 comic text-5xl text-accent text-stroke">
                  {step.n}
                </div>
                <div className="text-5xl mb-3 mt-4">{step.emoji}</div>
                <h3 className="comic text-2xl text-primary mb-2">{step.title}</h3>
                <p className="text-base">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 px-6 md:px-12 py-20">
        <div className="max-w-4xl mx-auto bg-cosmic border-4 border-primary rounded-3xl p-12 text-center shadow-toxic stars-bg relative overflow-hidden">
          <div className="absolute -top-10 -left-10 animate-float-fart">
            <FartCloud size={150} />
          </div>
          <div className="absolute -bottom-10 -right-10 animate-float-fart" style={{ animationDelay: "1.5s" }}>
            <FartCloud size={150} />
          </div>

          <div className="relative z-10">
            <h2 className="display text-4xl md:text-6xl text-primary text-stroke-thick mb-4">
              READY TO TOOT?
            </h2>
            <p className="comic text-2xl text-foreground mb-8">
              Join the FARTOLUTION. Be early. Be smelly. Be rich.
            </p>
            <Button
              onClick={blast}
              size="lg"
              className="bg-accent text-accent-foreground comic text-3xl px-12 py-8 border-4 border-background shadow-hard hover:shadow-pink transition-all animate-pulse-toxic"
            >
              🚀 BLAST OFF NOW 🚀
            </Button>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="relative z-10 border-t-4 border-primary bg-card/80 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 md:px-12 py-10">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-toxic flex items-center justify-center text-xl border-2 border-background">
                💩
              </div>
              <span className="comic text-xl text-primary">FART BLASTER 3000</span>
            </div>
            <div className="flex items-center gap-4 comic text-lg">
              <a href="#" className="hover:text-primary transition-colors">𝕏 TWITTER</a>
              <a href="#" className="hover:text-primary transition-colors">📨 TELEGRAM</a>
              <a href="#" className="hover:text-primary transition-colors">📊 DEXSCREENER</a>
            </div>
          </div>
          <div className="mt-8 text-center text-sm text-muted-foreground">
            <p className="comic text-base">⚠️ NOT FINANCIAL ADVICE. NOT MEDICAL ADVICE. DEFINITELY NOT DIETARY ADVICE.</p>
            <p className="mt-2">$FART is a meme coin with no intrinsic value or financial return expectations. Buy responsibly. Fart freely.</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Index;
