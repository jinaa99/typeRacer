import { DIFFICULTIES, type Difficulty } from '../../shared/passages';

export const DIFFICULTY_INFO: Record<Difficulty, { label: string; sample: string; blurb: string; lane: number }> = {
  easy: { label: 'Easy', sample: 'cat · dog · happy', blurb: 'Short, common words', lane: 0 },
  medium: { label: 'Medium', sample: 'morning · computer', blurb: 'Everyday vocabulary', lane: 1 },
  hard: { label: 'Hard', sample: 'extraordinary', blurb: 'Long words, complex sentences', lane: 2 },
};

interface Props {
  value: Difficulty;
  onChange: (d: Difficulty) => void;
  disabled?: boolean;
  /** Large cards (solo setup) or a compact segmented control (lobby). */
  variant?: 'cards' | 'segmented';
}

export function DifficultyPicker({ value, onChange, disabled, variant = 'cards' }: Props) {
  return (
    <div className={`difficulty difficulty-${variant}`} role="radiogroup" aria-label="Difficulty">
      {DIFFICULTIES.map((d, i) => {
        const info = DIFFICULTY_INFO[d];
        return (
          <label key={d} className={`difficulty-option lane-${info.lane}${value === d ? ' selected' : ''}`}>
            <input
              type="radio"
              name={`difficulty-${variant}`}
              value={d}
              checked={value === d}
              disabled={disabled}
              onChange={() => onChange(d)}
            />
            <span className="difficulty-name">{info.label}</span>
            {variant === 'cards' && (
              <>
                <span className="difficulty-sample">{info.sample}</span>
                <span className="difficulty-blurb">{info.blurb}</span>
                <kbd>{i + 1}</kbd>
              </>
            )}
          </label>
        );
      })}
    </div>
  );
}
