import { describe, expect, it } from 'vitest';
import {
  parseCreatePayload,
  parseDifficultyPayload,
  parseInputPayload,
  parseJoinPayload,
  parseName,
  parseReadyPayload,
  parseRejoinPayload,
  parseRoomCode,
} from '../server/validation';

describe('payload validation', () => {
  it('normalizes and validates names', () => {
    expect(parseName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(parseName('a\u0000b')).toBe('ab');
    for (const bad of ['', '   ', 'x'.repeat(21), 42, null, undefined, {}]) expect(parseName(bad)).toBeNull();
  });

  it('validates room codes', () => {
    expect(parseRoomCode(' abc234 ')).toBe('ABC234');
    for (const bad of ['ABC', 'ABCDEFG', 'AB-123', 123456, null]) expect(parseRoomCode(bad)).toBeNull();
  });

  it('rejects malformed payloads', () => {
    for (const bad of [null, undefined, 'x', 1, [], {}]) {
      expect(parseCreatePayload(bad)).toBeNull();
      expect(parseJoinPayload(bad)).toBeNull();
      expect(parseRejoinPayload(bad)).toBeNull();
      expect(parseReadyPayload(bad)).toBeNull();
      expect(parseDifficultyPayload(bad)).toBeNull();
      expect(parseInputPayload(bad)).toBeNull();
    }
    expect(parseReadyPayload({ ready: 'yes' })).toBeNull();
    expect(parseDifficultyPayload({ difficulty: 'insane' })).toBeNull();
    expect(parseRejoinPayload({ code: 'ABCDEF', token: 'short' })).toBeNull();
  });

  it('validates typing input batches', () => {
    expect(parseInputPayload({ raceId: 'r1', epoch: 0, events: ['a', '\b', ' '] })).toEqual({
      raceId: 'r1',
      epoch: 0,
      events: [{ type: 'char', char: 'a' }, { type: 'backspace' }, { type: 'char', char: ' ' }],
    });
    expect(parseInputPayload({ raceId: 'r1', epoch: 0, events: [] })).toBeNull();
    expect(parseInputPayload({ raceId: 'r1', epoch: 0, events: ['ab'] })).toBeNull();
    expect(parseInputPayload({ raceId: 'r1', epoch: -1, events: ['a'] })).toBeNull();
    expect(parseInputPayload({ raceId: 'r1', epoch: 0.5, events: ['a'] })).toBeNull();
    expect(parseInputPayload({ raceId: 'r1', epoch: 0, events: Array(201).fill('a') })).toBeNull();
    expect(parseInputPayload({ raceId: '', epoch: 0, events: ['a'] })).toBeNull();
  });
});
