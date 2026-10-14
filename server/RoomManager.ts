import { randomBytes, randomInt } from 'node:crypto';
import { buildRaceText, rememberRace, type Difficulty } from '../shared/passages';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROOM_CODE_LENGTH,
  type JoinResponse,
  type ProgressUpdate,
  type PublicRoomState,
  type RaceResults,
  type ResyncPayload,
  type RoomStatus,
} from '../shared/protocol';
import type { TypingEvent } from '../shared/typing';
import type { GameConfig } from './config';
import { Race } from './race';

/** Outbound side effects, implemented with Socket.IO in production. */
export interface Notifier {
  /** Adds a socket to a room's broadcast channel. */
  attach(socketId: string, code: string): void;
  /** Removes a socket from a room's broadcast channel and tells it why. */
  detach(socketId: string, code: string, reason: string | null): void;
  roomState(code: string, state: PublicRoomState): void;
  progress(code: string, update: ProgressUpdate): void;
  resync(socketId: string, payload: ResyncPayload): void;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

interface Player {
  id: string;
  token: string;
  name: string;
  socketId: string | null;
  ready: boolean;
  disconnectedAt: number | null;
  removalTimer: NodeJS.Timeout | null;
}

interface Room {
  code: string;
  hostId: string;
  /** Insertion order is join order, which decides host succession. */
  players: Map<string, Player>;
  difficulty: Difficulty;
  status: RoomStatus;
  race: Race | null;
  lastResults: RaceResults | null;
  recentPassageIds: string[];
  hostTimer: NodeJS.Timeout | null;
  raceTimers: NodeJS.Timeout[];
  progressTimer: NodeJS.Timeout | null;
  progressDirty: boolean;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly bySocket = new Map<string, { code: string; playerId: string }>();

  constructor(
    private readonly config: GameConfig,
    private readonly notifier: Notifier,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  createRoom(socketId: string, name: string): Result<JoinResponse> {
    if (this.rooms.size >= this.config.maxRooms) {
      return { ok: false, error: 'The server is full. Try again later.' };
    }
    this.leave(socketId);
    const room: Room = {
      code: this.generateCode(),
      hostId: '',
      players: new Map(),
      difficulty: 'medium',
      status: 'lobby',
      race: null,
      lastResults: null,
      recentPassageIds: [],
      hostTimer: null,
      raceTimers: [],
      progressTimer: null,
      progressDirty: false,
    };
    this.rooms.set(room.code, room);
    const player = this.addPlayer(room, socketId, name);
    room.hostId = player.id;
    this.broadcastState(room);
    return { ok: true, ...this.joinResponse(room, player, null) };
  }

  joinRoom(socketId: string, code: string, name: string): Result<JoinResponse> {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Room not found. Check the code and try again.' };
    const current = this.bySocket.get(socketId);
    if (current?.code === code) return { ok: false, error: 'You are already in this room.' };
    if (room.status !== 'lobby') return { ok: false, error: 'A race is already in progress in this room.' };
    if (room.players.size >= MAX_PLAYERS) return { ok: false, error: `Room is full (max ${MAX_PLAYERS} players).` };
    const lower = name.toLowerCase();
    for (const p of room.players.values()) {
      if (p.name.toLowerCase() === lower) return { ok: false, error: 'That name is already taken in this room.' };
    }
    this.leave(socketId);
    const player = this.addPlayer(room, socketId, name);
    this.broadcastState(room);
    return { ok: true, ...this.joinResponse(room, player, null) };
  }

  /** Reclaims a player slot after a refresh or dropped connection. */
  rejoinRoom(socketId: string, code: string, token: string): Result<JoinResponse> {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Room no longer exists.' };
    const player = [...room.players.values()].find((p) => p.token === token);
    if (!player) return { ok: false, error: 'Your seat in this room has expired.' };

    const current = this.bySocket.get(socketId);
    if (current && !(current.code === code && current.playerId === player.id)) this.leave(socketId);

    if (player.socketId && player.socketId !== socketId) {
      // The same player opened a new connection; the old one loses the seat.
      this.bySocket.delete(player.socketId);
      this.notifier.detach(player.socketId, code, 'You joined this room from another tab or device.');
    }
    if (player.removalTimer) clearTimeout(player.removalTimer);
    player.removalTimer = null;
    player.socketId = socketId;
    player.disconnectedAt = null;
    this.bySocket.set(socketId, { code, playerId: player.id });
    this.notifier.attach(socketId, code);
    this.reassignHostIfNeeded(room);

    const resync = room.race?.has(player.id) ? room.race.resync(player.id, 'Reconnected') : null;
    this.broadcastState(room);
    return { ok: true, ...this.joinResponse(room, player, resync) };
  }

  /** Voluntary leave: the player is removed immediately. */
  leave(socketId: string): void {
    const ctx = this.context(socketId);
    this.bySocket.delete(socketId);
    if (!ctx) return;
    ctx.player.socketId = null;
    this.notifier.detach(socketId, ctx.room.code, null);
    this.removePlayer(ctx.room, ctx.player.id);
  }

  /** Connection dropped: keep the seat for the reconnect grace period. */
  disconnect(socketId: string): void {
    const ref = this.bySocket.get(socketId);
    if (!ref) return;
    this.bySocket.delete(socketId);
    const room = this.rooms.get(ref.code);
    const player = room?.players.get(ref.playerId);
    if (!room || !player || player.socketId !== socketId) return;

    player.socketId = null;
    player.disconnectedAt = this.now();
    player.ready = false;
    player.removalTimer = setTimeout(() => this.removePlayer(room, player.id), this.config.reconnectGraceMs);

    if (room.hostId === player.id) {
      if (room.hostTimer) clearTimeout(room.hostTimer);
      room.hostTimer = setTimeout(() => {
        room.hostTimer = null;
        // The grace period is over when this fires. Don't re-check elapsed time:
        // timers can fire ~1ms before Date.now() catches up.
        if (this.reassignHostIfNeeded(room, true)) this.broadcastState(room);
      }, this.config.hostGraceMs);
    }
    this.broadcastState(room);
  }

  setReady(socketId: string, ready: boolean): Result {
    const ctx = this.context(socketId);
    if (!ctx) return { ok: false, error: 'You are not in a room.' };
    if (ctx.room.status !== 'lobby') return { ok: false, error: 'Cannot change ready state during a race.' };
    ctx.player.ready = ready;
    this.broadcastState(ctx.room);
    return { ok: true };
  }

  setDifficulty(socketId: string, difficulty: Difficulty): Result {
    const ctx = this.context(socketId);
    if (!ctx) return { ok: false, error: 'You are not in a room.' };
    if (ctx.room.hostId !== ctx.player.id) return { ok: false, error: 'Only the host can change the difficulty.' };
    if (ctx.room.status !== 'lobby') return { ok: false, error: 'Cannot change difficulty during a race.' };
    ctx.room.difficulty = difficulty;
    this.broadcastState(ctx.room);
    return { ok: true };
  }

  startRace(socketId: string): Result {
    const ctx = this.context(socketId);
    if (!ctx) return { ok: false, error: 'You are not in a room.' };
    const { room, player } = ctx;
    if (room.hostId !== player.id) return { ok: false, error: 'Only the host can start the race.' };
    if (room.status !== 'lobby') return { ok: false, error: 'A race is already in progress.' };
    const racers = [...room.players.values()].filter((p) => p.socketId !== null);
    if (racers.length < MIN_PLAYERS) {
      return { ok: false, error: `At least ${MIN_PLAYERS} connected players are needed to start.` };
    }
    if (racers.some((p) => !p.ready)) return { ok: false, error: 'All players must be ready.' };

    const passage = buildRaceText(room.difficulty, room.recentPassageIds, this.random);
    room.recentPassageIds = rememberRace(room.recentPassageIds, passage);
    const startAt = this.now() + this.config.countdownMs;
    const endsAt = startAt + this.config.raceMaxDurationMs;
    const race = new Race(randomId(6), passage, startAt, endsAt, racers, this.config);
    room.race = race;
    room.status = 'countdown';
    room.raceTimers = [
      setTimeout(() => {
        if (room.race !== race) return;
        room.status = 'racing';
        this.broadcastState(room);
      }, this.config.countdownMs),
      setTimeout(() => this.finishRace(room), this.config.countdownMs + this.config.raceMaxDurationMs),
    ];
    room.progressDirty = true;
    room.progressTimer = setInterval(() => this.flushProgress(room), this.config.progressIntervalMs);
    this.broadcastState(room);
    return { ok: true };
  }

  input(socketId: string, raceId: string, epoch: number, events: TypingEvent[]): void {
    const ctx = this.context(socketId);
    const race = ctx?.room.race;
    if (!ctx || !race || race.id !== raceId) return;
    const outcome = race.applyInput(ctx.player.id, epoch, events, this.now());
    if (outcome.kind === 'rejected') {
      this.notifier.resync(socketId, outcome.resync);
      return;
    }
    if (outcome.kind !== 'applied') return;
    ctx.room.progressDirty = true;
    if (outcome.finishedNow) {
      this.flushProgress(ctx.room);
      if (race.isComplete()) this.finishRace(ctx.room);
    }
  }

  /** Clears all timers; used on server shutdown and in tests. */
  shutdown(): void {
    for (const room of [...this.rooms.values()]) this.destroyRoom(room);
  }

  getState(code: string): PublicRoomState | null {
    const room = this.rooms.get(code);
    return room ? this.publicState(room) : null;
  }

  // --- internals ---------------------------------------------------------

  private context(socketId: string): { room: Room; player: Player } | null {
    const ref = this.bySocket.get(socketId);
    const room = ref && this.rooms.get(ref.code);
    const player = room?.players.get(ref!.playerId);
    return room && player ? { room, player } : null;
  }

  private addPlayer(room: Room, socketId: string, name: string): Player {
    const player: Player = {
      id: randomId(9),
      token: randomId(24),
      name,
      socketId,
      ready: false,
      disconnectedAt: null,
      removalTimer: null,
    };
    room.players.set(player.id, player);
    this.bySocket.set(socketId, { code: room.code, playerId: player.id });
    this.notifier.attach(socketId, room.code);
    return player;
  }

  private removePlayer(room: Room, playerId: string): void {
    const player = room.players.get(playerId);
    if (!player) return;
    if (player.removalTimer) clearTimeout(player.removalTimer);
    if (player.socketId) {
      this.bySocket.delete(player.socketId);
      this.notifier.detach(player.socketId, room.code, 'You were removed from the room.');
    }
    room.players.delete(playerId);
    if (room.players.size === 0) {
      this.destroyRoom(room);
      return;
    }
    if (room.hostId === playerId) this.transferHost(room);
    if (room.race) {
      room.race.markLeft(playerId);
      room.progressDirty = true;
      if (room.race.isComplete()) {
        this.finishRace(room);
        return;
      }
    }
    this.broadcastState(room);
  }

  /** Moves host to the earliest-joined connected player (or any player). */
  private transferHost(room: Room): void {
    if (room.hostTimer) clearTimeout(room.hostTimer);
    room.hostTimer = null;
    const players = [...room.players.values()];
    const next = players.find((p) => p.socketId !== null) ?? players[0];
    if (next) room.hostId = next.id;
  }

  /** Transfers host if the host has been disconnected past the grace period. */
  private reassignHostIfNeeded(room: Room, graceExpired = false): boolean {
    const host = room.players.get(room.hostId);
    if (host?.socketId) return false;
    if (
      !graceExpired &&
      host &&
      host.disconnectedAt !== null &&
      this.now() - host.disconnectedAt < this.config.hostGraceMs
    ) {
      return false;
    }
    const before = room.hostId;
    this.transferHost(room);
    // Only a connected player is a useful new host.
    return room.hostId !== before && room.players.get(room.hostId)?.socketId != null;
  }

  private finishRace(room: Room): void {
    const race = room.race;
    if (!race) return;
    this.flushProgress(room);
    this.clearRaceTimers(room);
    room.lastResults = race.results(this.now());
    room.race = null;
    room.status = 'lobby';
    for (const p of room.players.values()) p.ready = false;
    this.broadcastState(room);
  }

  private flushProgress(room: Room): void {
    if (!room.race || !room.progressDirty) return;
    room.progressDirty = false;
    const now = this.now();
    this.notifier.progress(room.code, { raceId: room.race.id, serverNow: now, players: room.race.progress(now) });
  }

  private clearRaceTimers(room: Room): void {
    room.raceTimers.forEach(clearTimeout);
    room.raceTimers = [];
    if (room.progressTimer) clearInterval(room.progressTimer);
    room.progressTimer = null;
  }

  private destroyRoom(room: Room): void {
    this.clearRaceTimers(room);
    if (room.hostTimer) clearTimeout(room.hostTimer);
    for (const p of room.players.values()) {
      if (p.removalTimer) clearTimeout(p.removalTimer);
      if (p.socketId) this.bySocket.delete(p.socketId);
    }
    this.rooms.delete(room.code);
  }

  private broadcastState(room: Room): void {
    if (this.rooms.get(room.code) !== room) return;
    this.notifier.roomState(room.code, this.publicState(room));
  }

  private publicState(room: Room): PublicRoomState {
    const race = room.race;
    return {
      code: room.code,
      status: room.status,
      difficulty: room.difficulty,
      hostId: room.hostId,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        connected: p.socketId !== null,
        isHost: p.id === room.hostId,
        inRace: race?.has(p.id) ?? false,
      })),
      race: race
        ? {
            id: race.id,
            difficulty: race.passage.difficulty,
            passage: race.passage.text,
            startAt: race.startAt,
            endsAt: race.endsAt,
          }
        : null,
      lastResults: room.lastResults,
      serverNow: this.now(),
    };
  }

  private joinResponse(room: Room, player: Player, resync: ResyncPayload | null): JoinResponse {
    return {
      session: { code: room.code, playerId: player.id, token: player.token },
      state: this.publicState(room),
      resync,
    };
  }

  private generateCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }
}

function randomId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}
