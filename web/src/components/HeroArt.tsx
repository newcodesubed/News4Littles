/** "A friendly newspaper under a sunny sky with floating world icons" — §3.2. */
export function HeroArt() {
  return (
    <svg
      viewBox="0 0 240 200"
      role="img"
      aria-label="A friendly newspaper under a sunny sky with floating world icons"
      className="w-full max-w-xs"
    >
      <circle cx="196" cy="42" r="26" fill="var(--color-sun)" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
        <line
          key={angle}
          x1="196"
          y1="42"
          x2={196 + 38 * Math.cos((angle * Math.PI) / 180)}
          y2={42 + 38 * Math.sin((angle * Math.PI) / 180)}
          stroke="var(--color-sun)"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.65"
        />
      ))}

      <g fill="#ffffff">
        <ellipse cx="52" cy="40" rx="26" ry="16" />
        <ellipse cx="34" cy="46" rx="18" ry="12" />
        <ellipse cx="72" cy="48" rx="16" ry="11" />
      </g>

      {/* Newspaper */}
      <g transform="rotate(-6 120 130)">
        <rect x="58" y="82" width="124" height="96" rx="10" fill="#ffffff" stroke="var(--color-ink)" strokeWidth="3" />
        <rect x="72" y="96" width="96" height="16" rx="5" fill="var(--color-brand)" />
        <rect x="72" y="122" width="42" height="42" rx="6" fill="var(--color-sun-wash)" stroke="var(--color-sun)" strokeWidth="2" />
        <circle cx="93" cy="140" r="10" fill="var(--color-sun)" />
        {[124, 136, 148, 160].map((y) => (
          <rect key={y} x="124" y={y} width="44" height="6" rx="3" fill="var(--color-paper-deep)" />
        ))}
      </g>

      {/* Floating world icons */}
      <g>
        <circle cx="30" cy="120" r="14" fill="var(--color-brand-wash)" stroke="var(--color-brand)" strokeWidth="2" />
        <path d="M16 120h28M30 106c6 8 6 20 0 28M30 106c-6 8-6 20 0 28" stroke="var(--color-brand)" strokeWidth="2" fill="none" />
      </g>
      <path d="M212 118c8 0 12 6 12 12s-6 10-12 10-10-4-10-10 4-12 10-12z" fill="#86c98a" />
      <path d="M212 118v22" stroke="#4f9b57" strokeWidth="2" />
      <path
        d="M206 172l4 8 9 1-6 6 1 9-8-4-8 4 1-9-6-6 9-1z"
        fill="var(--color-sun)"
        opacity="0.9"
      />
    </svg>
  );
}
