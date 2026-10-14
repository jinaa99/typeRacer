import { describe, expect, it } from 'vitest';
import {
  buildRaceText,
  DIFFICULTIES,
  PASSAGES,
  RECENT_PASSAGE_LIMIT,
  rememberRace,
  TARGET_RACE_LENGTH,
  validatePassage,
} from '../shared/passages';

describe('passage datasets', () => {
  it.each(DIFFICULTIES)('%s passages are all valid and unique', (difficulty) => {
    const passages = PASSAGES[difficulty];
    expect(passages.length).toBeGreaterThanOrEqual(20);
    for (const p of passages) {
      expect(validatePassage(p.text, difficulty), p.text).toEqual([]);
      expect(p.difficulty).toBe(difficulty);
    }
    expect(new Set(passages.map((p) => p.text)).size).toBe(passages.length);
    expect(new Set(passages.map((p) => p.id)).size).toBe(passages.length);
  });

  it('difficulties are ordered by average word length', () => {
    const avg = (d: (typeof DIFFICULTIES)[number]) => {
      const words = PASSAGES[d].flatMap((p) => p.text.match(/[A-Za-z']+/g) ?? []);
      return words.reduce((s, w) => s + w.length, 0) / words.length;
    };
    expect(avg('easy')).toBeLessThan(avg('medium'));
    expect(avg('medium')).toBeLessThan(avg('hard'));
  });

  it('rejects unsuitable passages', () => {
    expect(validatePassage('', 'easy')).toEqual(['passage is empty']);
    expect(validatePassage('   ', 'easy')).toEqual(['passage is empty']);
    expect(validatePassage('The cat sat on the mat and it was a very nice day for all of us.\n', 'easy')).not.toEqual([]);
    expect(validatePassage('The cat sat on the mat and it was a  very nice day for all of us.', 'easy')).not.toEqual([]);
    expect(validatePassage('The cat sat on the “mat” and it was a very nice day for all of us.', 'easy')).not.toEqual([]);
    expect(validatePassage('Extraordinarily sophisticated responsibilities overwhelmed everyone.', 'easy')).not.toEqual([]);
    expect(validatePassage('The cat sat.', 'hard')).not.toEqual([]);
  });
});

describe('buildRaceText', () => {
  it('targets about 2 minutes at 50 WPM', () => {
    expect(TARGET_RACE_LENGTH).toBe(500);
  });

  it.each(DIFFICULTIES)('builds a %s race close to the target length from distinct passages', (difficulty) => {
    const longest = Math.max(...PASSAGES[difficulty].map((p) => p.text.length));
    for (let i = 0; i < 50; i++) {
      const race = buildRaceText(difficulty);
      expect(race.difficulty).toBe(difficulty);
      expect(Math.abs(race.text.length - TARGET_RACE_LENGTH)).toBeLessThanOrEqual(longest / 2 + 1);
      expect(race.partIds.length).toBeGreaterThan(1);
      expect(new Set(race.partIds).size).toBe(race.partIds.length);
      expect(race.partIds.every((id) => id.startsWith(`${difficulty}-`))).toBe(true);
      // Parts are joined with single spaces, so the text stays valid typing input.
      expect(race.text).not.toMatch(/ {2}/);
      expect(race.text).toMatch(/^[\x20-\x7e]+$/);
      expect(race.text).toBe(race.partIds.map((id) => PASSAGES[difficulty].find((p) => p.id === id)!.text).join(' '));
    }
  });

  it('prefers passages that were not used recently', () => {
    const all = PASSAGES.medium;
    const keep = new Set(all.slice(-4).map((p) => p.id));
    const recent = all.filter((p) => !keep.has(p.id)).map((p) => p.id);
    for (let i = 0; i < 10; i++) {
      const race = buildRaceText('medium', recent);
      expect(race.partIds.every((id) => keep.has(id))).toBe(true);
    }
  });

  it('falls back to recent passages when fresh ones run out', () => {
    const recent = PASSAGES.easy.map((p) => p.id);
    expect(buildRaceText('easy', recent).text.length).toBeGreaterThan(TARGET_RACE_LENGTH / 2);
  });

  it('is deterministic for a given random source', () => {
    const seeded = () => {
      let x = 42;
      return () => (x = (x * 16807) % 2147483647) / 2147483647;
    };
    expect(buildRaceText('hard', [], seeded()).text).toBe(buildRaceText('hard', [], seeded()).text);
  });

  it.each(DIFFICULTIES)('does not reuse %s passages in back-to-back races', (difficulty) => {
    let recent: string[] = [];
    let previous: string[] = [];
    for (let i = 0; i < 6; i++) {
      const race = buildRaceText(difficulty, recent);
      expect(race.partIds.filter((id) => previous.includes(id))).toEqual([]);
      previous = race.partIds;
      recent = rememberRace(recent, race);
      expect(recent.length).toBeLessThanOrEqual(RECENT_PASSAGE_LIMIT);
    }
  });
});
