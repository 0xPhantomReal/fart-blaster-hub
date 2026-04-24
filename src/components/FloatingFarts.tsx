import FartCloud from "./FartCloud";

const FloatingFarts = () => {
  const farts = Array.from({ length: 8 }).map((_, i) => ({
    left: `${(i * 13 + 5) % 95}%`,
    delay: `${i * 2}s`,
    duration: `${10 + (i % 4) * 2}s`,
    size: 40 + (i % 3) * 20,
  }));

  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      {farts.map((f, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            left: f.left,
            bottom: "-100px",
            animation: `rise-fart ${f.duration} linear infinite`,
            animationDelay: f.delay,
          }}
        >
          <FartCloud size={f.size} />
        </div>
      ))}
    </div>
  );
};

export default FloatingFarts;
