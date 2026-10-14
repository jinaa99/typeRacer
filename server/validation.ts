import { isDifficulty, type Difficulty } from '../shared/passages';
import { MAX_EVENTS_PER_BATCH, MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '../shared/protocol';
import { decodeEvent, type TypingEvent } from '../shared/typing';

/** Validators for untrusted socket payloads. Each returns null when invalid. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  // Strip control characters and collapse whitespace.
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

export function parseRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return new RegExp(`^[A-Z0-9]{${ROOM_CODE_LENGTH}}$`).test(code) ? code : null;
}

export function parseCreatePayload(payload: unknown): { name: string } | null {
  if (!isRecord(payload)) return null;
  const name = parseName(payload.name);
  return name ? { name } : null;
}

export function parseJoinPayload(payload: unknown): { code: string; name: string } | null {
  if (!isRecord(payload)) return null;
  const code = parseRoomCode(payload.code);
  const name = parseName(payload.name);
  return code && name ? { code, name } : null;
}

export function parseRejoinPayload(payload: unknown): { code: string; token: string } | null {
  if (!isRecord(payload)) return null;
  const code = parseRoomCode(payload.code);
  const token = payload.token;
  if (!code || typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return { code, token };
}

export function parseReadyPayload(payload: unknown): { ready: boolean } | null {
  if (!isRecord(payload) || typeof payload.ready !== 'boolean') return null;
  return { ready: payload.ready };
}

export function parseDifficultyPayload(payload: unknown): { difficulty: Difficulty } | null {
  if (!isRecord(payload) || !isDifficulty(payload.difficulty)) return null;
  return { difficulty: payload.difficulty };
}

export function parseInputPayload(
  payload: unknown,
): { raceId: string; epoch: number; events: TypingEvent[] } | null {
  if (!isRecord(payload)) return null;
  const { raceId, epoch, events } = payload;
  if (typeof raceId !== 'string' || raceId.length === 0 || raceId.length > 64) return null;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) return null;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_BATCH) return null;
  const decoded: TypingEvent[] = [];
  for (const raw of events) {
    const event = decodeEvent(raw);
    if (!event) return null;
    decoded.push(event);
  }
  return { raceId, epoch, events: decoded };
}
