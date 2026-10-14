import { describe, expect, it } from 'vitest';
import { LANE_COUNT, laneForChar, SPACE_LANE } from '../src/track/lanes';
import { wordWindow } from '../src/track/words';
import { PASSAGES } from '../shared/passages';

describe('laneForChar', () => {
  it('assigns lanes by keyboard zone', () => {
    expect([...'aqz'].map(laneForChar)).toEqual([0, 0, 0]);
    expect([...'bgrt'].map(laneForChar)).toEqual([1, 1, 1, 1]);
    expect([...'nhyu'].map(laneForChar)).toEqual([2, 2, 2, 2]);
    expect([...'olp.,'].map(laneForChar)).toEqual([3, 3, 3, 3, 3]);
  });

  it('uses the same lane for shifted characters', () => {
    expect(laneForChar('A')).toBe(laneForChar('a'));
    expect(laneForChar('!')).toBe(laneForChar('1'));
    expect(laneForChar('?')).toBe(laneForChar('/'));
    expect(laneForChar('"')).toBe(laneForChar("'"));
    expect(laneForChar('|')).toBe(laneForChar('\\'));
  });

  it('maps space to the space lane and every passage character to a valid lane', () => {
    expect(laneForChar(' ')).toBe(SPACE_LANE);
    for (const list of Object.values(PASSAGES)) {
      for (const p of list) {
        for (const ch of p.text.replace(/ /g, '')) {
          const lane = laneForChar(ch);
          expect(lane).toBeGreaterThanOrEqual(0);
          expect(lane).toBeLessThan(LANE_COUNT);
        }
      }
    }
  });
});

describe('wordWindow', () => {
  const text = 'hidden global enter key';

  it('returns the word at the caret and the next words', () => {
    expect(wordWindow(text, 0)).toEqual({
      current: { text: 'hidden', start: 0 },
      caretOnSpace: false,
      next: ['global', 'enter', 'key'],
    });
    expect(wordWindow(text, 3).current.text).toBe('hidden');
  });

  it('keeps the word while the caret is on its trailing space', () => {
    const w = wordWindow(text, 6);
    expect(w.current.text).toBe('hidden');
    expect(w.caretOnSpace).toBe(true);
    expect(wordWindow(text, 7).current).toEqual({ text: 'global', start: 7 });
  });

  it('handles the end of the passage and out-of-range carets', () => {
    expect(wordWindow(text, text.length)).toEqual({ current: { text: 'key', start: 20 }, caretOnSpace: false, next: [] });
    expect(wordWindow(text, 999).current.text).toBe('key');
    expect(wordWindow(text, -5).current.text).toBe('hidden');
    expect(wordWindow('one', 0, 3).next).toEqual([]);
  });
});
