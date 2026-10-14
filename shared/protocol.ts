import type { Difficulty } from './passages';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MAX_NAME_LENGTH = 20;
export const ROOM_CODE_LENGTH = 6;
/** Max typing events the server accepts in one `race:input` batch. */
export const MAX_EVENTS_PER_BATCH = 200;
/** How often the client flushes queued typing events to the server. */
export const INPUT_FLUSH_MS = 100;

export type RoomStatus = 'lobby' | 'countdown' | 'racing';

export interface PublicPlayer {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  /** True if the player is taking part in the current race. */
  inRace: boolean;
}

export interface PublicRace {
  id: string;
  difficulty: Difficulty;
  passage: string;
  /** Server epoch ms at which typing is allowed. */
  startAt: number;
  /** Server epoch ms after which unfinished players are marked DNF. */
  endsAt: number;
}

export interface RaceResultEntry {
  playerId: string;
  name: string;
  /** 1-based place among finishers; null if the player did not finish. */
  place: number | null;
  finished: boolean;
  completionMs: number | null;
  wpm: number;
  accuracy: number;
  errors: number;
  progress: number;
  left: boolean;
}

export interface RaceResults {
  raceId: string;
  difficulty: Difficulty;
  passageLength: number;
  entries: RaceResultEntry[];
}

export interface PublicRoomState {
  code: string;
  status: RoomStatus;
  difficulty: Difficulty;
  hostId: string;
  players: PublicPlayer[];
  race: PublicRace | null;
  lastResults: RaceResults | null;
  /** Server epoch ms when this state was sent, used for clock offset. */
  serverNow: number;
}

export interface ProgressEntry {
  playerId: string;
  progress: number;
  correctChars: number;
  wpm: number;
  finished: boolean;
  place: number | null;
  completionMs: number | null;
}

export interface ProgressUpdate {
  raceId: string;
  serverNow: number;
  players: ProgressEntry[];
}

/** Authoritative typing state for one player, sent to that player only. */
export interface ResyncPayload {
  raceId: string;
  epoch: number;
  typed: string;
  correctLength: number;
  totalAttempts: number;
  correctAttempts: number;
  backspaces: number;
  finishedAt: number | null;
  reason: string;
}

export interface Session {
  code: string;
  playerId: string;
  /** Secret used to reclaim this player slot after a reconnect or refresh. */
  token: string;
}

export type Ack<T = object> = (response: ({ ok: true } & T) | { ok: false; error: string }) => void;

export type JoinResponse = { session: Session; state: PublicRoomState; resync: ResyncPayload | null };

export interface ClientToServerEvents {
  'room:create': (payload: { name: string }, ack: Ack<JoinResponse>) => void;
  'room:join': (payload: { code: string; name: string }, ack: Ack<JoinResponse>) => void;
  'room:rejoin': (payload: { code: string; token: string }, ack: Ack<JoinResponse>) => void;
  'room:leave': (ack?: Ack) => void;
  'room:ready': (payload: { ready: boolean }, ack: Ack) => void;
  'room:difficulty': (payload: { difficulty: Difficulty }, ack: Ack) => void;
  'race:start': (ack: Ack) => void;
  'race:input': (payload: { raceId: string; epoch: number; events: string[] }) => void;
}

export interface ServerToClientEvents {
  'room:state': (state: PublicRoomState) => void;
  'race:progress': (update: ProgressUpdate) => void;
  'race:resync': (payload: ResyncPayload) => void;
  'room:removed': (payload: { reason: string }) => void;
}
