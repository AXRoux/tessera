/** Hero artwork: one obligation, one lock, one payment. Chamfered frames, a blue block, a black square. */
export function HeroArt() {
  return (
    <svg viewBox="0 0 520 520" className="h-full w-full" role="img" aria-label="Nested chamfered squares: one lock around one payment">
      <defs>
        <linearGradient id="payonce-glow" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0a2bd6" />
          <stop offset="1" stopColor="#1f4dff" />
        </linearGradient>
        <pattern id="payonce-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke="#0b0d12" strokeOpacity="0.07" />
        </pattern>
      </defs>
      <rect width="520" height="520" fill="url(#payonce-grid)" />
      <line x1="40" y1="480" x2="480" y2="40" stroke="#0b0d12" strokeOpacity="0.22" />
      <polygon points="40,40 440,40 480,80 480,480 80,480 40,440" fill="none" stroke="#0b0d12" strokeWidth="1.5" />
      <polygon points="100,100 380,100 420,140 420,420 140,420 100,380" fill="none" stroke="#1f4dff" strokeWidth="1.5" />
      <polygon points="160,250 310,250 350,290 350,420 200,420 160,380" fill="url(#payonce-glow)" />
      <rect x="360" y="100" width="60" height="60" fill="#0b0d12" />
      <polygon points="360,100 420,100 420,160" fill="#1f4dff" />
      <g fontFamily="ui-monospace, Menlo, monospace" fontSize="10" letterSpacing="2" fill="#0b0d12">
        <text x="56" y="30">1 INVOICE</text>
        <text x="104" y="92" fill="#1f4dff">1 LOCK</text>
        <text x="168" y="244">1 PAYMENT</text>
        <text x="372" y="182" fill="#5c5e62">NEVER 2</text>
      </g>
    </svg>
  );
}
