import { easyPassages } from './easy';
import { mediumPassages } from './medium';
import { hardPassages } from './hard';

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface Passage {
  /** Stable id, e.g. "medium-4". Append new passages to keep ids stable. */
  id: string;
  difficulty: Difficulty;
  text: string;
}

/**
 * Rules a passage must satisfy for its difficulty. They keep the difficulty
 * consistent when the dataset is expanded; tests run every passage through
 * `validatePassage`.
 */
export const DIFFICULTY_RULES: Record<
  Difficulty,
  { minLength: number; maxLength: number; minAvgWordLength: number; maxAvgWordLength: number; maxWordLength: number }
> = {
  easy: { minLength: 40, maxLength: 140, minAvgWordLength: 2.5, maxAvgWordLength: 4.2, maxWordLength: 8 },
  medium: { minLength: 120, maxLength: 260, minAvgWordLength: 4.0, maxAvgWordLength: 6.0, maxWordLength: 14 },
  hard: { minLength: 180, maxLength: 400, minAvgWordLength: 6.0, maxAvgWordLength: 11, maxWordLength: 20 },
};

const RAW: Record<Difficulty, readonly string[]> = {
  easy: easyPassages,
  medium: mediumPassages,
  hard: hardPassages,
};

export const PASSAGES: Record<Difficulty, readonly Passage[]> = {
  easy: toPassages('easy'),
  medium: toPassages('medium'),
  hard: toPassages('hard'),
};

function toPassages(difficulty: Difficulty): Passage[] {
  return RAW[difficulty].map((text, i) => ({ id: `${difficulty}-${i}`, difficulty, text }));
}

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
}

/** Returns a list of problems with the passage; empty means it is valid. */
export function validatePassage(text: string, difficulty: Difficulty): string[] {
  const problems: string[] = [];
  const rules = DIFFICULTY_RULES[difficulty];
  if (text.trim().length === 0) return ['passage is empty'];
  if (!/^[\x20-\x7e]+$/.test(text)) problems.push('contains characters that are not printable ASCII');
  if (text !== text.trim()) problems.push('has leading or trailing whitespace');
  if (/ {2}/.test(text)) problems.push('contains consecutive spaces');
  if (!/^[A-Z]/.test(text)) problems.push('does not start with a capital letter');
  if (!/[.!?]$/.test(text)) problems.push('does not end with sentence punctuation');
  if (text.length < rules.minLength || text.length > rules.maxLength) {
    problems.push(`length ${text.length} outside ${rules.minLength}-${rules.maxLength}`);
  }
  const words = text.match(/[A-Za-z']+/g) ?? [];
  if (words.length === 0) {
    problems.push('contains no words');
  } else {
    const avg = words.reduce((sum, w) => sum + w.length, 0) / words.length;
    if (avg < rules.minAvgWordLength || avg > rules.maxAvgWordLength) {
      problems.push(`average word length ${avg.toFixed(2)} outside ${rules.minAvgWordLength}-${rules.maxAvgWordLength}`);
    }
    const longest = Math.max(...words.map((w) => w.length));
    if (longest > rules.maxWordLength) problems.push(`word of length ${longest} exceeds ${rules.maxWordLength}`);
  }
  return problems;
}

/**
 * Target race length in characters: about 2 minutes at 50 WPM
 * (WPM counts 5 characters as one word).
 */
export const TARGET_RACE_SECONDS = 120;
export const REFERENCE_WPM = 50;
export const TARGET_RACE_LENGTH = Math.round((TARGET_RACE_SECONDS / 60) * REFERENCE_WPM * 5);

/** How many recently used passage ids a lobby (or solo session) remembers. */
export const RECENT_PASSAGE_LIMIT = 30;

/** Text for one race, built from several passages of the same difficulty. */
export interface RaceText extends Passage {
  /** Ids of the passages joined into `text`, in order. */
  partIds: string[];
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Builds a race text of about `targetLength` characters by joining random
 * passages of one difficulty. Passages in `recentIds` are used only when the
 * fresh ones run out, and no passage appears twice in one race.
 */
export function buildRaceText(
  difficulty: Difficulty,
  recentIds: readonly string[] = [],
  random: () => number = Math.random,
  targetLength: number = TARGET_RACE_LENGTH,
): RaceText {
  const all = PASSAGES[difficulty];
  if (all.length === 0) throw new Error(`No passages for difficulty ${difficulty}`);
  const recent = new Set(recentIds);
  const candidates = [
    ...shuffled(all.filter((p) => !recent.has(p.id)), random),
    ...shuffled(all.filter((p) => recent.has(p.id)), random),
  ];

  const parts: Passage[] = [];
  let length = 0;
  for (const p of candidates) {
    const next = parts.length === 0 ? p.text.length : length + 1 + p.text.length;
    // Stop once another passage would move us further from the target.
    if (parts.length > 0 && Math.abs(next - targetLength) >= Math.abs(length - targetLength)) break;
    parts.push(p);
    length = next;
  }

  return {
    id: parts.map((p) => p.id).join('+'),
    difficulty,
    text: parts.map((p) => p.text).join(' '),
    partIds: parts.map((p) => p.id),
  };
}

/** Adds a race's passages to the recent list, keeping only the newest ids. */
export function rememberRace(recentIds: readonly string[], race: RaceText, limit = RECENT_PASSAGE_LIMIT): string[] {
  const used = new Set(race.partIds);
  return [...recentIds.filter((id) => !used.has(id)), ...race.partIds].slice(-limit);
}
