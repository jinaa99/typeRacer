import { useEffect, useRef, useState } from 'react';
import { buildRaceText, DIFFICULTIES, rememberRace, type Difficulty, type Passage } from '../../shared/passages';
import {
  applyEvent,
  createTypingState,
  formatDuration,
  getResult,
  isFinished,
  type TypingEvent,
  type TypingState,
} from '../../shared/typing';
import { DIFFICULTY_INFO, DifficultyPicker } from '../components/DifficultyPicker';
import { TopbarActions } from '../components/TopbarSlot';
import { useNow } from '../hooks/useNow';
import { RhythmTrack } from '../track/RhythmTrack';

export function SoloMode({ onExit }: { onExit: () => void }) {
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [passage, setPassage] = useState<Passage | null>(null);
  const [state, setState] = useState<TypingState | null>(null);
  const recentIds = useRef<string[]>([]);
  // Remounts the track on every new race so it resets and refocuses.
  const [round, setRound] = useState(0);

  const running = state !== null && state.startedAt !== null && !isFinished(state);
  const now = useNow(running);
  const finished = state !== null && isFinished(state);

  const startRace = () => {
    const next = buildRaceText(difficulty, recentIds.current);
    recentIds.current = rememberRace(recentIds.current, next);
    setPassage(next);
    setRound((r) => r + 1);
    // The clock starts on the first typed character.
    setState(createTypingState(next.text));
  };
  const backToSetup = () => {
    setPassage(null);
    setState(null);
  };

  // Shortcuts: 1/2/3 + Enter on setup, Enter after a race, Esc for a new passage.
  const startRef = useRef(startRace);
  useEffect(() => {
    startRef.current = startRace;
  });
  const inRace = passage !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Enter on a focused button already clicks it.
      if (e.target instanceof HTMLButtonElement && e.key === 'Enter') return;
      if (!inRace) {
        const index = Number(e.key) - 1;
        if (DIFFICULTIES[index]) setDifficulty(DIFFICULTIES[index]);
        else if (e.key === 'Enter') startRef.current();
      } else if (e.key === 'Escape' || (finished && e.key === 'Enter')) {
        e.preventDefault();
        startRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inRace, finished]);

  const handleEvent = (event: TypingEvent) => {
    const at = Date.now();
    setState((s) => (s ? applyEvent(s, event, at) : s));
  };

  if (!passage || !state) {
    return (
      <div className="page page-center">
        <TopbarActions>
          <button className="btn btn-ghost" onClick={onExit}>
            ← Menu
          </button>
        </TopbarActions>
        <div className="setup">
          <p className="eyebrow">Solo race</p>
          <h2 className="page-title">Choose your difficulty</h2>
          <DifficultyPicker value={difficulty} onChange={setDifficulty} />
          <button className="btn btn-primary btn-lg" onClick={startRace}>
            Start race <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    );
  }

  const result = getResult(state, finished ? state.finishedAt! : now);

  return (
    <div className="page page-race">
      <TopbarActions>
        <button className="btn btn-ghost" onClick={startRace}>
          New passage <kbd>Esc</kbd>
        </button>
        <button className="btn btn-ghost hide-sm" onClick={backToSetup}>
          Difficulty
        </button>
        <button className="btn btn-ghost" onClick={onExit}>
          ← Menu
        </button>
      </TopbarActions>
      <RhythmTrack
        key={round}
        state={state}
        now={now}
        title="Solo race"
        subtitle={DIFFICULTY_INFO[passage.difficulty].label}
        onEvent={handleEvent}
        overlay={
          finished && (
            <div className="results-card" data-testid="solo-results">
              <p className="eyebrow">Finished</p>
              <div className="results-hero">
                <span className="results-wpm">{Math.round(result.wpm)}</span>
                <span className="results-unit">WPM</span>
              </div>
              <dl className="results-grid">
                <div>
                  <dt>Accuracy</dt>
                  <dd>{result.accuracy.toFixed(1)}%</dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>{formatDuration(result.elapsedMs)}</dd>
                </div>
                <div>
                  <dt>Errors</dt>
                  <dd>{result.errors}</dd>
                </div>
                <div>
                  <dt>Characters</dt>
                  <dd>{state.passage.length}</dd>
                </div>
              </dl>
              <div className="results-actions">
                <button className="btn btn-primary" onClick={startRace}>
                  Race again <kbd>Enter</kbd>
                </button>
                <button className="btn" onClick={backToSetup}>
                  Change difficulty
                </button>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}
