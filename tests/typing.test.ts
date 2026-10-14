import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applyEvents,
  calculateAccuracy,
  calculateWpm,
  createTypingState,
  decodeEvent,
  elapsedMs,
  encodeEvent,
  formatDuration,
  getResult,
  isFinished,
  MAX_UNCORRECTED_ERRORS,
  pendingErrors,
  progress,
  validateState,
  type TypingEvent,
} from '../shared/typing';

const chars = (text: string): TypingEvent[] => [...text].map((char) => ({ type: 'char', char }));
const BS: TypingEvent = { type: 'backspace' };

describe('typing engine', () => {
  it('rejects empty passages', () => {
    expect(() => createTypingState('')).toThrow();
  });

  it('tracks correct characters and progress', () => {
    const s = applyEvents(createTypingState('hello world'), chars('hello'), 1000);
    expect(s.typed).toBe('hello');
    expect(s.correctLength).toBe(5);
    expect(s.totalAttempts).toBe(5);
    expect(s.correctAttempts).toBe(5);
    expect(progress(s)).toBeCloseTo(5 / 11);
    expect(isFinished(s)).toBe(false);
  });

  it('starts the clock on the first character only', () => {
    let s = createTypingState('abc');
    s = applyEvent(s, BS, 500);
    expect(s.startedAt).toBeNull();
    s = applyEvent(s, { type: 'char', char: 'a' }, 1000);
    s = applyEvent(s, { type: 'char', char: 'b' }, 2000);
    expect(s.startedAt).toBe(1000);
  });

  it('keeps a preset start time (multiplayer)', () => {
    const s = applyEvent(createTypingState('abc', 100), { type: 'char', char: 'a' }, 1000);
    expect(s.startedAt).toBe(100);
  });

  it('marks characters after a mistake as incorrect until corrected', () => {
    let s = applyEvents(createTypingState('cat dog'), chars('cxt'), 0);
    expect(s.correctLength).toBe(1);
    expect(pendingErrors(s)).toBe(2);
    expect(s.correctAttempts).toBe(1);
    expect(s.totalAttempts).toBe(3);
    // 't' at index 2 matches the passage but follows an uncorrected mistake.
    s = applyEvents(s, [BS, BS], 0);
    expect(s.typed).toBe('c');
    expect(s.correctLength).toBe(1);
    s = applyEvents(s, chars('at dog'), 10_000);
    expect(isFinished(s)).toBe(true);
    expect(s.totalAttempts).toBe(9);
    expect(s.correctAttempts).toBe(7);
  });

  it('backspace on correct text reduces progress and retyping counts again', () => {
    let s = applyEvents(createTypingState('abc'), chars('ab'), 0);
    s = applyEvent(s, BS, 0);
    expect(s.correctLength).toBe(1);
    expect(s.backspaces).toBe(1);
    s = applyEvents(s, chars('bc'), 0);
    expect(isFinished(s)).toBe(true);
    expect(s.totalAttempts).toBe(4);
    expect(s.correctAttempts).toBe(4);
  });

  it('ignores backspace on an empty buffer', () => {
    const s = createTypingState('abc');
    expect(applyEvent(s, BS, 0)).toBe(s);
  });

  it('caps uncorrected mistakes', () => {
    const s = applyEvents(createTypingState('a'.repeat(50)), chars('b'.repeat(20)), 0);
    expect(pendingErrors(s)).toBe(MAX_UNCORRECTED_ERRORS);
    expect(s.totalAttempts).toBe(MAX_UNCORRECTED_ERRORS);
  });

  it('does not allow typing beyond the end of the passage', () => {
    let s = applyEvents(createTypingState('ab'), chars('ax'), 0);
    const before = s;
    s = applyEvent(s, { type: 'char', char: 'z' }, 0);
    expect(s).toBe(before);
    expect(s.typed).toBe('ax');
  });

  it('ignores all input after completion', () => {
    const done = applyEvents(createTypingState('ab'), chars('ab'), 5);
    expect(isFinished(done)).toBe(true);
    expect(applyEvent(done, BS, 9)).toBe(done);
    expect(applyEvent(done, { type: 'char', char: 'c' }, 9)).toBe(done);
  });

  it('ignores invalid characters (empty, multi-char, control)', () => {
    const s = createTypingState('abc');
    for (const char of ['', 'ab', '\n', '\t', '\u0000', '\uD83D']) {
      expect(applyEvent(s, { type: 'char', char }, 0)).toBe(s);
    }
  });

  it('records the finish time when the last correct character is typed', () => {
    const s = applyEvents(createTypingState('hi', 1000), chars('hi'), 13_000);
    expect(s.finishedAt).toBe(13_000);
    expect(elapsedMs(s, 99_999)).toBe(12_000);
  });

  it('validates consistent and inconsistent states', () => {
    const s = applyEvents(createTypingState('hello'), chars('help'), 0);
    expect(validateState(s)).toBe(true);
    expect(validateState({ ...s, correctLength: 4 })).toBe(false);
    expect(validateState({ ...s, correctAttempts: 99 })).toBe(false);
    expect(validateState({ ...s, finishedAt: 5 })).toBe(false);
  });
});

describe('event encoding', () => {
  it('round-trips characters and backspace', () => {
    for (const e of [...chars('a Z.'), BS]) expect(decodeEvent(encodeEvent(e))).toEqual(e);
  });

  it('rejects malformed raw events', () => {
    for (const raw of ['', 'ab', 5, null, undefined, {}, ['a'], '\n']) expect(decodeEvent(raw)).toBeNull();
  });
});

describe('scoring', () => {
  it('computes WPM as chars / 5 per minute', () => {
    expect(calculateWpm(250, 60_000)).toBe(50);
    expect(calculateWpm(100, 30_000)).toBe(40);
  });

  it('handles zero or invalid elapsed time', () => {
    expect(calculateWpm(100, 0)).toBe(0);
    expect(calculateWpm(100, -5)).toBe(0);
    expect(calculateWpm(100, NaN)).toBe(0);
    expect(calculateWpm(0, 1000)).toBe(0);
  });

  it('computes accuracy over all attempts', () => {
    expect(calculateAccuracy(9, 10)).toBe(90);
    expect(calculateAccuracy(0, 0)).toBe(0);
    expect(calculateAccuracy(5, 5)).toBe(100);
  });

  it('produces final results from a finished state', () => {
    // 10 chars in 6 seconds = 2 words / 0.1 min = 20 WPM.
    let s = createTypingState('abcdefghij', 0);
    s = applyEvents(s, chars('abx'), 1000);
    s = applyEvent(s, BS, 2000);
    s = applyEvents(s, chars('cdefghij'), 6000);
    const r = getResult(s, 999_999);
    expect(r.finished).toBe(true);
    expect(r.elapsedMs).toBe(6000);
    expect(r.wpm).toBeCloseTo(20);
    expect(r.errors).toBe(1);
    expect(r.accuracy).toBeCloseTo((10 / 11) * 100);
    expect(r.progress).toBe(1);
  });

  it('reports zero stats before the race starts', () => {
    const r = getResult(createTypingState('abc'), 5000);
    expect(r).toMatchObject({ elapsedMs: 0, wpm: 0, accuracy: 0, errors: 0, progress: 0, finished: false });
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00.0');
    expect(formatDuration(65_400)).toBe('1:05.4');
  });
});
