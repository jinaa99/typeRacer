/**
 * Pure typing engine shared by solo mode (browser) and multiplayer (server).
 *
 * Input model
 * - Input is a sequence of events: a single typed character or a backspace.
 *   Paste, drag-and-drop and multi-character insertions are not events and are
 *   rejected by the UI and the server.
 * - `typed` is the player's current buffer. It may contain mistakes; the
 *   `correctLength` prefix is the part that matches the passage.
 * - A character attempt is correct only when there are no uncorrected
 *   mistakes before it and it equals the expected passage character.
 * - Once a mistake is made, at most MAX_UNCORRECTED_ERRORS characters can be
 *   typed past the correct prefix. Further characters are ignored (not counted)
 *   until the player backspaces.
 * - Typing beyond the end of the passage is ignored.
 * - Backspace removes the last typed character, correct or not. It is not an
 *   attempt and does not change accuracy.
 *
 * Scoring
 * - Every counted character attempt is in `totalAttempts`. Mistakes stay
 *   counted after they are corrected, so corrected mistakes lower accuracy.
 *   They do not lower WPM directly; they only cost time.
 * - WPM = correct characters / 5 / elapsed minutes. A finished race has every
 *   passage character correct, so final WPM = passage length / 5 / minutes.
 * - Accuracy = correct attempts / total attempts * 100. It is 0 when there
 *   are no attempts.
 */

export const MAX_UNCORRECTED_ERRORS = 8;
export const BACKSPACE = '\b';

export type TypingEvent = { type: 'char'; char: string } | { type: 'backspace' };

export interface TypingState {
  readonly passage: string;
  readonly typed: string;
  /** Length of the prefix of `typed` that matches the passage. */
  readonly correctLength: number;
  readonly totalAttempts: number;
  readonly correctAttempts: number;
  readonly backspaces: number;
  /** Timestamp (ms) the race clock started, or null if not started yet. */
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface TypingResult {
  finished: boolean;
  elapsedMs: number;
  correctChars: number;
  wpm: number;
  accuracy: number;
  errors: number;
  progress: number;
}

export function createTypingState(passage: string, startedAt: number | null = null): TypingState {
  if (passage.length === 0) throw new Error('Passage must not be empty');
  return {
    passage,
    typed: '',
    correctLength: 0,
    totalAttempts: 0,
    correctAttempts: 0,
    backspaces: 0,
    startedAt,
    finishedAt: null,
  };
}

/** True for a single printable character that can be a typing event. */
export function isTypeableChar(char: unknown): char is string {
  if (typeof char !== 'string' || char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f && !(code >= 0xd800 && code <= 0xdfff);
}

/**
 * Applies one event and returns the new state, or the same state object if
 * the event was ignored. `now` starts the clock on the first character when
 * the state has no start time (solo mode).
 */
export function applyEvent(state: TypingState, event: TypingEvent, now: number): TypingState {
  if (state.finishedAt !== null) return state;

  if (event.type === 'backspace') {
    if (state.typed.length === 0) return state;
    const typed = state.typed.slice(0, -1);
    return {
      ...state,
      typed,
      correctLength: Math.min(state.correctLength, typed.length),
      backspaces: state.backspaces + 1,
    };
  }

  if (!isTypeableChar(event.char)) return state;
  if (state.typed.length >= state.passage.length) return state;
  if (state.typed.length - state.correctLength >= MAX_UNCORRECTED_ERRORS) return state;

  const startedAt = state.startedAt ?? now;
  const correct =
    state.typed.length === state.correctLength && state.passage[state.typed.length] === event.char;
  const correctLength = correct ? state.correctLength + 1 : state.correctLength;

  return {
    ...state,
    typed: state.typed + event.char,
    correctLength,
    totalAttempts: state.totalAttempts + 1,
    correctAttempts: state.correctAttempts + (correct ? 1 : 0),
    startedAt,
    finishedAt: correctLength === state.passage.length ? Math.max(now, startedAt) : null,
  };
}

export function applyEvents(state: TypingState, events: readonly TypingEvent[], now: number): TypingState {
  return events.reduce((s, e) => applyEvent(s, e, now), state);
}

/** Wire encoding: a typed character is itself, backspace is "\b". */
export function encodeEvent(event: TypingEvent): string {
  return event.type === 'backspace' ? BACKSPACE : event.char;
}

export function decodeEvent(raw: unknown): TypingEvent | null {
  if (raw === BACKSPACE) return { type: 'backspace' };
  if (isTypeableChar(raw)) return { type: 'char', char: raw };
  return null;
}

export function isFinished(state: TypingState): boolean {
  return state.finishedAt !== null;
}

/** Number of uncorrected wrong characters at the end of the buffer. */
export function pendingErrors(state: TypingState): number {
  return state.typed.length - state.correctLength;
}

export function progress(state: TypingState): number {
  return state.correctLength / state.passage.length;
}

export function elapsedMs(state: TypingState, now: number): number {
  if (state.startedAt === null) return 0;
  return Math.max(0, (state.finishedAt ?? now) - state.startedAt);
}

export function calculateWpm(correctChars: number, elapsed: number): number {
  if (!(elapsed > 0) || correctChars <= 0) return 0;
  return correctChars / 5 / (elapsed / 60_000);
}

export function calculateAccuracy(correctAttempts: number, totalAttempts: number): number {
  if (totalAttempts <= 0) return 0;
  return (Math.min(correctAttempts, totalAttempts) / totalAttempts) * 100;
}

export function getResult(state: TypingState, now: number): TypingResult {
  const elapsed = elapsedMs(state, now);
  return {
    finished: isFinished(state),
    elapsedMs: elapsed,
    correctChars: state.correctLength,
    wpm: calculateWpm(state.correctLength, elapsed),
    accuracy: calculateAccuracy(state.correctAttempts, state.totalAttempts),
    errors: state.totalAttempts - state.correctAttempts,
    progress: progress(state),
  };
}

/**
 * Checks that a state's counters agree with each other and with the passage.
 * Used as a sanity check before results are published.
 */
export function validateState(state: TypingState): boolean {
  const { passage, typed, correctLength, correctAttempts, totalAttempts } = state;
  if (correctLength < 0 || correctLength > typed.length || typed.length > passage.length) return false;
  if (passage.slice(0, correctLength) !== typed.slice(0, correctLength)) return false;
  if (correctAttempts > totalAttempts || correctAttempts < correctLength) return false;
  if (typed.length - correctLength > MAX_UNCORRECTED_ERRORS) return false;
  if (state.finishedAt !== null) {
    if (typed !== passage || state.startedAt === null || state.finishedAt < state.startedAt) return false;
  }
  return true;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}
