export function SakuraGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={className} fill="currentColor" viewBox="0 0 100 100">
      {[0, 72, 144, 216, 288].map((angle) => (
        <ellipse cx="50" cy="29" key={angle} rx="13" ry="22" transform={`rotate(${angle} 50 50)`} />
      ))}
      <circle cx="50" cy="50" fill="rgba(255,255,255,0.55)" r="6.5" />
    </svg>
  );
}
