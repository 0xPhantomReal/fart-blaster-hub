interface FartCloudProps {
  size?: number;
  className?: string;
  delay?: string;
}

const FartCloud = ({ size = 80, className = "", delay = "0s" }: FartCloudProps) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      style={{ animationDelay: delay }}
    >
      <g>
        <circle cx="30" cy="55" r="22" fill="hsl(var(--toxic))" opacity="0.85" />
        <circle cx="55" cy="40" r="25" fill="hsl(var(--toxic-glow))" opacity="0.9" />
        <circle cx="70" cy="60" r="20" fill="hsl(var(--toxic))" opacity="0.85" />
        <circle cx="45" cy="65" r="18" fill="hsl(var(--toxic-glow))" opacity="0.85" />
        <circle cx="60" cy="50" r="15" fill="hsl(var(--toxic))" opacity="0.7" />
        {/* face */}
        <circle cx="42" cy="48" r="2.5" fill="hsl(var(--background))" />
        <circle cx="58" cy="48" r="2.5" fill="hsl(var(--background))" />
        <path d="M 42 56 Q 50 62 58 56" stroke="hsl(var(--background))" strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
};

export default FartCloud;
