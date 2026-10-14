const LANE_COLORS = ['var(--lane-0)', 'var(--lane-1)', 'var(--lane-2)', 'var(--lane-3)'];
const LETTERS = 'TYPERACEFASTWORDSKEYS';

// Generated once at module load so renders stay pure.
const NOTES = Array.from({ length: 22 }, (_, i) => ({
  letter: LETTERS[i % LETTERS.length],
  left: 4 + ((i * 37) % 92),
  delay: -((i * 1.7) % 12),
  duration: 9 + ((i * 2.3) % 7),
  color: LANE_COLORS[i % LANE_COLORS.length],
  size: 0.8 + ((i * 7) % 5) / 10,
}));

/** Decorative background of slowly falling note circles. */
export function FallingLetters() {
  return (
    <div className="falling" aria-hidden="true">
      {NOTES.map((n, i) => (
        <span
          key={i}
          className="falling-note"
          style={{
            left: `${n.left}%`,
            animationDelay: `${n.delay}s`,
            animationDuration: `${n.duration}s`,
            color: n.color,
            fontSize: `${n.size}rem`,
          }}
        >
          {n.letter}
        </span>
      ))}
    </div>
  );
}
