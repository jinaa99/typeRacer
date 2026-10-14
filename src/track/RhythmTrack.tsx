import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  formatDuration,
  getResult,
  isFinished,
  MAX_UNCORRECTED_ERRORS,
  pendingErrors,
  type TypingEvent,
  type TypingState,
} from '../../shared/typing';
import { TypingInput } from '../components/TypingInput';
import { HIT_LINE_RATIO, TrackRenderer } from './renderer';
import { wordWindow } from './words';

interface Props {
  state: TypingState;
  /** Current time (ms, local clock) used for the live timer and WPM. */
  now: number;
  title: string;
  subtitle?: string;
  /** Milliseconds until the race starts, or null when not counting down. */
  countdownMs?: number | null;
  /** True when input is not accepted (countdown, spectating). */
  disabled?: boolean;
  onEvent: (event: TypingEvent) => void;
  /** Content for the middle of the HUD (race status, racers). */
  hudCenter?: ReactNode;
  /** Small message shown at the top of the track. */
  banner?: ReactNode;
  /** Panel drawn over the track (results). */
  overlay?: ReactNode;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Falling-notes typing view: HUD on top, the note track with the hit line,
 * and the current/upcoming words under the line. Owns the hidden input that
 * captures keystrokes and also catches keys typed while it is not focused.
 */
export function RhythmTrack({
  state,
  now,
  title,
  subtitle,
  countdownMs = null,
  disabled = false,
  onEvent,
  hudCenter,
  banner,
  overlay,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<TrackRenderer | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onEventRef = useRef(onEvent);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    const renderer = new TrackRenderer(canvasRef.current!);
    rendererRef.current = renderer;
    return () => renderer.destroy();
  }, []);

  useEffect(() => {
    rendererRef.current?.setState(state);
  }, [state]);

  const countdownSeconds = countdownMs !== null && countdownMs > 0 ? Math.ceil(countdownMs / 1000) : null;
  useEffect(() => {
    rendererRef.current?.setCountdown(countdownSeconds);
  }, [countdownSeconds]);

  const finished = isFinished(state);
  const inputActive = !disabled && !finished;

  // Keys typed while focus is elsewhere on the page (after clicking a button
  // or the HUD) still go to the race instead of being lost.
  useEffect(() => {
    if (!inputActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const input = inputRef.current;
      if (!input || document.activeElement === input) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || EDITABLE_TAGS.has(target.tagName))) return;
      let event: TypingEvent | null = null;
      if (e.key === 'Backspace') event = { type: 'backspace' };
      else if (e.key.length === 1) event = { type: 'char', char: e.key };
      if (!event) return;
      e.preventDefault();
      input.focus();
      onEventRef.current(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [inputActive]);

  const result = getResult(state, finished ? state.finishedAt! : now);
  const caret = state.typed.length;
  const words = wordWindow(state.passage, caret);
  const tooManyErrors = pendingErrors(state) >= MAX_UNCORRECTED_ERRORS;
  const percent = Math.floor(result.progress * 100);

  const charClass = (index: number) =>
    index < state.correctLength ? 'done' : index < caret ? 'wrong' : index === caret ? 'caret' : 'todo';

  return (
    <div className="track">
      <div className="track-hud">
        <div className="hud-panel">
          <span className="hud-label">WPM</span>
          <span className="hud-value" data-testid="stat-wpm">
            {Math.round(result.wpm)}
          </span>
          <span className="hud-sub">
            <span data-testid="stat-time">{formatDuration(result.elapsedMs)}</span>
            <span className="hud-dot">·</span>
            <span data-testid="stat-errors">{result.errors}</span> err
          </span>
        </div>

        <div className="hud-center">{hudCenter}</div>

        <div className="hud-panel hud-right">
          <span className="hud-title">{title}</span>
          {subtitle && <span className="hud-label">{subtitle}</span>}
          <span className="hud-value hud-accuracy" data-testid="stat-accuracy">
            {result.accuracy.toFixed(1)}%
          </span>
          <div className="hud-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="hud-progress-fill" style={{ width: `${result.progress * 100}%` }} />
          </div>
          <span className="hud-label">{percent}%</span>
        </div>
      </div>

      <div
        className="track-stage"
        style={{ ['--hit' as string]: `${HIT_LINE_RATIO * 100}%` }}
        onMouseDown={(e) => {
          if (overlay) return;
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <canvas ref={canvasRef} className="track-canvas" aria-hidden="true" />

        <div className="track-words" aria-hidden="true">
          <div className="word-current">
            {[...words.current.text].map((char, i) => (
              <span key={i} className={charClass(words.current.start + i)}>
                {char}
              </span>
            ))}
            {words.caretOnSpace && <span className={`space ${charClass(caret)}`}>{' '}</span>}
          </div>
          {words.next.map((word, i) => (
            <div key={`${words.current.start}-${i}`} className={`word-next word-next-${i}`}>
              {word}
            </div>
          ))}
        </div>

        {banner && <div className="track-banner">{banner}</div>}
        {!banner && tooManyErrors && (
          <p className="track-banner track-banner-danger" role="alert">
            Backspace to fix mistakes
          </p>
        )}
        {!banner && !tooManyErrors && inputActive && !focused && (
          <div className="track-banner track-banner-accent">Click or start typing</div>
        )}
        {!banner && !tooManyErrors && inputActive && focused && state.startedAt === null && (
          <div className="track-banner">Start typing — the timer starts on your first key</div>
        )}

        {inputActive && (
          <TypingInput
            className="track-input"
            inputRef={inputRef}
            disabled={false}
            autoFocus
            onEvent={onEvent}
            onFocusChange={setFocused}
          />
        )}

        {overlay && <div className="track-overlay">{overlay}</div>}
      </div>

      {/* Full passage for screen readers and tests. */}
      <p className="sr-only" data-testid="passage">
        <span className="passage-correct">{state.passage.slice(0, state.correctLength)}</span>
        <span className="passage-wrong">{state.passage.slice(state.correctLength, caret)}</span>
        <span>{state.passage.slice(caret)}</span>
      </p>
    </div>
  );
}
