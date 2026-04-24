const items = [
  "💨 TOOT TO THE MOON",
  "🚀 FART BLASTER 3000",
  "💩 NO UTILITY JUST FARTS",
  "🌬️ THE MEME THAT RIPS",
  "💚 POWERED BY FART JUICE",
  "⚡ RIPPING GAINS ONLY",
  "🌌 JOIN THE FARTOLUTION",
];

const Marquee = () => {
  const loop = [...items, ...items, ...items];
  return (
    <div className="relative bg-toxic border-y-4 border-background py-4 overflow-hidden -rotate-2 shadow-toxic">
      <div
        className="flex gap-12 whitespace-nowrap"
        style={{ animation: "scroll-x 30s linear infinite" }}
      >
        {loop.map((item, i) => (
          <span
            key={i}
            className="comic text-3xl md:text-4xl text-background font-bold"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
};

export default Marquee;
