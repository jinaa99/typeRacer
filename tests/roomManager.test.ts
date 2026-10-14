import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GAME_CONFIG, type GameConfig } from '../server/config';
import { RoomManager, type Notifier } from '../server/RoomManager';
import type { ProgressUpdate, PublicRoomState, ResyncPayload } from '../shared/protocol';
import type { TypingEvent } from '../shared/typing';

const config: GameConfig = {
  ...DEFAULT_GAME_CONFIG,
  countdownMs: 3000,
  reconnectGraceMs: 10_000,
  hostGraceMs: 2000,
  raceMaxDurationMs: 120_000,
  progressIntervalMs: 250,
  maxRooms: 5,
};

function createNotifier() {
  const states = new Map<string, PublicRoomState>();
  const progress: ProgressUpdate[] = [];
  const resyncs: { socketId: string; payload: ResyncPayload }[] = [];
  const detached: { socketId: string; reason: string | null }[] = [];
  const notifier: Notifier = {
    attach: () => {},
    detach: (socketId, _code, reason) => detached.push({ socketId, reason }),
    roomState: (code, state) => states.set(code, state),
    progress: (_code, update) => progress.push(update),
    resync: (socketId, payload) => resyncs.push({ socketId, payload }),
  };
  return { notifier, states, progress, resyncs, detached };
}

const chars = (text: string): TypingEvent[] => [...text].map((char) => ({ type: 'char', char }));

let n: ReturnType<typeof createNotifier>;
let m: RoomManager;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  n = createNotifier();
  m = new RoomManager(config, n.notifier);
});

afterEach(() => {
  m.shutdown();
  vi.useRealTimers();
});

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`Expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

/** Creates a room with the given players (first is host), all ready. */
function setupRoom(names: string[], ready = true) {
  const host = ok(m.createRoom('s0', names[0]));
  const code = host.session.code;
  const sessions = [host.session];
  names.slice(1).forEach((name, i) => sessions.push(ok(m.joinRoom(`s${i + 1}`, code, name)).session));
  if (ready) names.forEach((_, i) => ok(m.setReady(`s${i}`, true)));
  return { code, sessions, state: () => n.states.get(code)! };
}

function startRace(code: string) {
  ok(m.startRace('s0'));
  const race = n.states.get(code)!.race!;
  vi.advanceTimersByTime(config.countdownMs);
  return race;
}

/** Types the passage at a plausible pace, finishing at `finishAfterMs` after the start. */
function typePassage(socketId: string, raceId: string, passage: string, finishAfterMs: number, epoch = 0) {
  const steps = 10;
  const t0 = Date.now();
  for (let i = 0; i < steps; i++) {
    vi.setSystemTime(t0 + ((i + 1) * finishAfterMs) / steps);
    const part = passage.slice(Math.floor((i * passage.length) / steps), Math.floor(((i + 1) * passage.length) / steps));
    if (part) m.input(socketId, raceId, epoch, chars(part));
  }
}

describe('lobby creation and joining', () => {
  it('creates a room with a unique code and the creator as host', () => {
    const a = ok(m.createRoom('s0', 'Ann'));
    const b = ok(m.createRoom('s1', 'Bob'));
    expect(a.session.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(a.session.code).not.toBe(b.session.code);
    expect(a.state.hostId).toBe(a.session.playerId);
    expect(a.state.players).toHaveLength(1);
    expect(a.state.status).toBe('lobby');
  });

  it('does not expose player tokens in public state', () => {
    const { state, sessions } = setupRoom(['Ann', 'Bob']);
    expect(JSON.stringify(state())).not.toContain(sessions[0].token);
    expect(JSON.stringify(state())).not.toContain(sessions[1].token);
  });

  it('rejects invalid room codes', () => {
    expect(m.joinRoom('s1', 'ZZZZZZ', 'Bob')).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) });
  });

  it('rejects duplicate names case-insensitively', () => {
    const { code } = setupRoom(['Ann']);
    expect(m.joinRoom('s1', code, 'ann')).toMatchObject({ ok: false, error: expect.stringMatching(/taken/) });
  });

  it('rejects the same socket joining the same room twice', () => {
    const { code } = setupRoom(['Ann', 'Bob']);
    expect(m.joinRoom('s1', code, 'Bobby')).toMatchObject({ ok: false });
    expect(n.states.get(code)!.players).toHaveLength(2);
  });

  it('enforces the 8 player capacity', () => {
    const { code } = setupRoom(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'], false);
    expect(n.states.get(code)!.players).toHaveLength(8);
    expect(m.joinRoom('s8', code, 'P8')).toMatchObject({ ok: false, error: expect.stringMatching(/full/) });
  });

  it('limits the number of rooms', () => {
    for (let i = 0; i < config.maxRooms; i++) ok(m.createRoom(`x${i}`, 'A'));
    expect(m.createRoom('y', 'A')).toMatchObject({ ok: false });
  });

  it('moves a socket to the new room when it joins another one', () => {
    const a = setupRoom(['Ann', 'Bob']);
    const other = ok(m.createRoom('z', 'Zed'));
    ok(m.joinRoom('s1', other.session.code, 'Bob'));
    expect(n.states.get(a.code)!.players.map((p) => p.name)).toEqual(['Ann']);
  });
});

describe('ready state and host permissions', () => {
  it('requires at least two connected players', () => {
    setupRoom(['Ann']);
    expect(m.startRace('s0')).toMatchObject({ ok: false, error: expect.stringMatching(/At least 2/) });
  });

  it('requires all players to be ready', () => {
    const { state } = setupRoom(['Ann', 'Bob'], false);
    ok(m.setReady('s0', true));
    expect(m.startRace('s0')).toMatchObject({ ok: false, error: expect.stringMatching(/ready/) });
    ok(m.setReady('s1', true));
    ok(m.startRace('s0'));
    expect(state().status).toBe('countdown');
  });

  it('only lets the host start the race or change difficulty', () => {
    const { state } = setupRoom(['Ann', 'Bob']);
    expect(m.startRace('s1')).toMatchObject({ ok: false, error: expect.stringMatching(/host/) });
    expect(m.setDifficulty('s1', 'hard')).toMatchObject({ ok: false, error: expect.stringMatching(/host/) });
    ok(m.setDifficulty('s0', 'hard'));
    expect(state().difficulty).toBe('hard');
  });

  it('rejects actions from sockets that are not in a room', () => {
    expect(m.setReady('nobody', true)).toMatchObject({ ok: false });
    expect(m.startRace('nobody')).toMatchObject({ ok: false });
    expect(m.setDifficulty('nobody', 'easy')).toMatchObject({ ok: false });
    expect(() => m.input('nobody', 'x', 0, chars('a'))).not.toThrow();
  });
});

describe('races', () => {
  it('shares one passage of the chosen difficulty and a synchronized start', () => {
    const { code, state } = setupRoom(['Ann', 'Bob', 'Cid']);
    ok(m.setDifficulty('s0', 'easy'));
    ok(m.startRace('s0'));
    const s = state();
    expect(s.status).toBe('countdown');
    expect(s.race!.difficulty).toBe('easy');
    expect(s.race!.startAt).toBe(Date.now() + config.countdownMs);
    expect(s.players.every((p) => p.inRace)).toBe(true);
    // Every player receives the same broadcast state, so the same passage.
    expect(n.states.get(code)!.race!.passage).toBe(s.race!.passage);
    vi.advanceTimersByTime(config.countdownMs);
    expect(state().status).toBe('racing');
  });

  it('blocks joining, ready changes and difficulty changes during a race', () => {
    const { code } = setupRoom(['Ann', 'Bob']);
    ok(m.startRace('s0'));
    expect(m.joinRoom('s9', code, 'Late')).toMatchObject({ ok: false, error: expect.stringMatching(/in progress/) });
    expect(m.setReady('s1', false)).toMatchObject({ ok: false });
    expect(m.setDifficulty('s0', 'hard')).toMatchObject({ ok: false });
    expect(m.startRace('s0')).toMatchObject({ ok: false });
  });

  it('rejects input before the start with a resync', () => {
    const { state } = setupRoom(['Ann', 'Bob']);
    ok(m.startRace('s0'));
    const race = state().race!;
    m.input('s1', race.id, 0, chars(race.passage.slice(0, 3)));
    expect(n.resyncs).toHaveLength(1);
    expect(n.resyncs[0]).toMatchObject({ socketId: 's1', payload: { typed: '', epoch: 1 } });
    // The stale epoch is ignored after the resync.
    vi.advanceTimersByTime(config.countdownMs + 1000);
    m.input('s1', race.id, 0, chars(race.passage.slice(0, 3)));
    vi.advanceTimersByTime(config.progressIntervalMs);
    expect(n.progress.at(-1)!.players.find((p) => p.playerId === state().players[1].id)!.correctChars).toBe(0);
    m.input('s1', race.id, 1, chars(race.passage.slice(0, 3)));
    vi.advanceTimersByTime(config.progressIntervalMs);
    expect(n.progress.at(-1)!.players.find((p) => p.playerId === state().players[1].id)!.correctChars).toBe(3);
  });

  it('rejects implausibly fast input', () => {
    const { code } = setupRoom(['Ann', 'Bob']);
    const race = startRace(code);
    m.input('s1', race.id, 0, chars(race.passage));
    expect(n.resyncs.at(-1)).toMatchObject({ socketId: 's1', payload: { typed: '', reason: expect.stringMatching(/plausible/) } });
  });

  it('ignores input for the wrong race id', () => {
    const { code } = setupRoom(['Ann', 'Bob']);
    startRace(code);
    m.input('s0', 'not-the-race', 0, chars('a'));
    expect(n.resyncs).toHaveLength(0);
  });

  it('ranks players by server-observed finish time and computes results', () => {
    const { code, state, sessions } = setupRoom(['Ann', 'Bob', 'Cid']);
    ok(m.setDifficulty('s0', 'easy'));
    const race = startRace(code);
    const start = Date.now();

    // Bob makes and corrects one mistake, then finishes first at 40s.
    const typo = race.passage[0] === 'x' ? 'y' : 'x';
    vi.setSystemTime(start + 1000);
    m.input('s1', race.id, 0, [{ type: 'char', char: typo }, { type: 'backspace' }]);
    typePassage('s1', race.id, race.passage, 39_000);
    expect(state().status).toBe('racing');

    vi.setSystemTime(start);
    typePassage('s0', race.id, race.passage, 50_000);
    expect(state().status).toBe('racing');

    vi.setSystemTime(start);
    typePassage('s2', race.id, race.passage, 60_000);

    // Everyone finished, so the race ends immediately.
    const s = state();
    expect(s.status).toBe('lobby');
    expect(s.race).toBeNull();
    expect(s.players.every((p) => !p.ready)).toBe(true);
    const entries = s.lastResults!.entries;
    expect(entries.map((e) => e.playerId)).toEqual([sessions[1].playerId, sessions[0].playerId, sessions[2].playerId]);
    expect(entries.map((e) => e.place)).toEqual([1, 2, 3]);
    expect(entries[0].completionMs).toBe(40_000);
    expect(entries[0].wpm).toBeCloseTo(race.passage.length / 5 / (40_000 / 60_000));
    expect(entries[0].errors).toBe(1);
    expect(entries[0].accuracy).toBeCloseTo((race.passage.length / (race.passage.length + 1)) * 100);
    expect(entries[1]).toMatchObject({ completionMs: 50_000, accuracy: 100, errors: 0, finished: true });
  });

  it('marks unfinished players DNF when the race times out', () => {
    const { code, state, sessions } = setupRoom(['Ann', 'Bob']);
    const race = startRace(code);
    typePassage('s0', race.id, race.passage, 60_000);
    vi.setSystemTime(Date.now() + 500);
    m.input('s1', race.id, 0, chars(race.passage.slice(0, 5)));
    vi.advanceTimersByTime(config.raceMaxDurationMs);
    const results = state().lastResults!;
    expect(results.entries[0]).toMatchObject({ playerId: sessions[0].playerId, place: 1, finished: true });
    expect(results.entries[1]).toMatchObject({ playerId: sessions[1].playerId, place: null, finished: false, completionMs: null });
    expect(results.entries[1].progress).toBeCloseTo(5 / race.passage.length);
  });

  it('broadcasts progress at the configured interval only when it changed', () => {
    const { code } = setupRoom(['Ann', 'Bob']);
    const race = startRace(code);
    const before = n.progress.length;
    vi.advanceTimersByTime(config.progressIntervalMs * 4);
    expect(n.progress.length - before).toBeLessThanOrEqual(1);
    m.input('s0', race.id, 0, chars(race.passage.slice(0, 2)));
    vi.advanceTimersByTime(config.progressIntervalMs);
    const last = n.progress.at(-1)!;
    expect(last.raceId).toBe(race.id);
    expect(last.players).toHaveLength(2);
  });

  it('supports repeated races in the same lobby with different passages', () => {
    const { code, state } = setupRoom(['Ann', 'Bob']);
    const passages: string[] = [];
    for (let round = 0; round < 3; round++) {
      ok(m.setReady('s0', true));
      ok(m.setReady('s1', true));
      const race = startRace(code);
      passages.push(race.passage);
      const t0 = Date.now();
      typePassage('s0', race.id, race.passage, 30_000);
      vi.setSystemTime(t0);
      typePassage('s1', race.id, race.passage, 31_000);
      expect(state().status).toBe('lobby');
      expect(state().lastResults!.raceId).toBe(race.id);
    }
    expect(new Set(passages).size).toBe(3);
  });
});

describe('disconnects, reconnects and host transfer', () => {
  it('keeps a disconnected player seat and restores it with the token', () => {
    const { code, sessions, state } = setupRoom(['Ann', 'Bob']);
    m.disconnect('s1');
    expect(state().players[1]).toMatchObject({ connected: false, ready: false });
    const r = ok(m.rejoinRoom('s1-new', code, sessions[1].token));
    expect(r.session.playerId).toBe(sessions[1].playerId);
    expect(state().players[1].connected).toBe(true);
    // The old socket no longer controls the player; the new one does.
    expect(m.setReady('s1', true)).toMatchObject({ ok: false });
    ok(m.setReady('s1-new', true));
  });

  it('rejects rejoin with an unknown token or room', () => {
    const { code } = setupRoom(['Ann']);
    expect(m.rejoinRoom('x', code, 'a'.repeat(32))).toMatchObject({ ok: false });
    expect(m.rejoinRoom('x', 'NOROOM', 'a'.repeat(32))).toMatchObject({ ok: false });
  });

  it('removes a disconnected player after the grace period', () => {
    const { code, sessions, state } = setupRoom(['Ann', 'Bob']);
    m.disconnect('s1');
    vi.advanceTimersByTime(config.reconnectGraceMs);
    expect(state().players).toHaveLength(1);
    expect(m.rejoinRoom('s1', code, sessions[1].token)).toMatchObject({ ok: false });
  });

  it('kicks the older connection when the same player connects twice', () => {
    const { code, sessions } = setupRoom(['Ann', 'Bob']);
    ok(m.rejoinRoom('s1-tab2', code, sessions[1].token));
    expect(n.detached.at(-1)).toMatchObject({ socketId: 's1', reason: expect.any(String) });
    expect(n.states.get(code)!.players).toHaveLength(2);
  });

  it('transfers host after the host grace period', () => {
    const { sessions, state } = setupRoom(['Ann', 'Bob', 'Cid']);
    m.disconnect('s0');
    vi.advanceTimersByTime(config.hostGraceMs - 1);
    expect(state().hostId).toBe(sessions[0].playerId);
    vi.advanceTimersByTime(1);
    expect(state().hostId).toBe(sessions[1].playerId);
    // The new host can start a race with the remaining ready players.
    ok(m.startRace('s1'));
  });

  it('transfers host even if the timer fires slightly before Date.now() catches up', () => {
    const { sessions, state } = setupRoom(['Ann', 'Bob']);
    m.disconnect('s0');
    // Node timers may fire ~1ms early relative to the wall clock.
    vi.setSystemTime(Date.now() - 1);
    vi.advanceTimersByTime(config.hostGraceMs);
    expect(state().hostId).toBe(sessions[1].playerId);
  });

  it('keeps host if the host reconnects within the grace period', () => {
    const { code, sessions, state } = setupRoom(['Ann', 'Bob']);
    m.disconnect('s0');
    vi.advanceTimersByTime(config.hostGraceMs / 2);
    ok(m.rejoinRoom('s0b', code, sessions[0].token));
    vi.advanceTimersByTime(config.hostGraceMs);
    expect(state().hostId).toBe(sessions[0].playerId);
  });

  it('transfers host immediately when the host leaves', () => {
    const { sessions, state } = setupRoom(['Ann', 'Bob']);
    m.leave('s0');
    expect(state().hostId).toBe(sessions[1].playerId);
    expect(state().players).toHaveLength(1);
    // A voluntary leave does not send a "removed" notice.
    expect(n.detached.at(-1)).toMatchObject({ socketId: 's0', reason: null });
  });

  it('skips disconnected players when choosing a new host', () => {
    const { sessions, state } = setupRoom(['Ann', 'Bob', 'Cid']);
    m.disconnect('s1');
    m.leave('s0');
    expect(state().hostId).toBe(sessions[2].playerId);
  });

  it('deletes the room when the last player leaves or times out', () => {
    const a = setupRoom(['Ann']);
    m.leave('s0');
    expect(m.getState(a.code)).toBeNull();
    const b = ok(m.createRoom('s5', 'Bo'));
    m.disconnect('s5');
    expect(m.getState(b.session.code)).not.toBeNull();
    vi.advanceTimersByTime(config.reconnectGraceMs);
    expect(m.getState(b.session.code)).toBeNull();
    expect(m.roomCount).toBe(0);
  });

  it('lets a player reconnect mid-race and continue from server state', () => {
    const { code, sessions, state } = setupRoom(['Ann', 'Bob']);
    const race = startRace(code);
    vi.setSystemTime(Date.now() + 2000);
    m.input('s1', race.id, 0, chars(race.passage.slice(0, 10)));
    m.disconnect('s1');
    const r = ok(m.rejoinRoom('s1b', code, sessions[1].token));
    expect(r.resync).toMatchObject({ raceId: race.id, typed: race.passage.slice(0, 10), epoch: 1 });
    vi.setSystemTime(Date.now() + 2000);
    m.input('s1b', race.id, 1, chars(race.passage.slice(10, 20)));
    vi.advanceTimersByTime(config.progressIntervalMs);
    const mine = n.progress.at(-1)!.players.find((p) => p.playerId === sessions[1].playerId)!;
    expect(mine.correctChars).toBe(20);
    expect(state().status).toBe('racing');
  });

  it('ends the race when the remaining players finish after another leaves', () => {
    const { code, sessions, state } = setupRoom(['Ann', 'Bob', 'Cid']);
    const race = startRace(code);
    m.leave('s2');
    const t0 = Date.now();
    typePassage('s0', race.id, race.passage, 30_000);
    expect(state().status).toBe('racing');
    vi.setSystemTime(t0);
    typePassage('s1', race.id, race.passage, 35_000);
    const results = state().lastResults!;
    expect(results.entries.map((e) => e.playerId)).toEqual([
      sessions[0].playerId,
      sessions[1].playerId,
      sessions[2].playerId,
    ]);
    expect(results.entries[2]).toMatchObject({ left: true, finished: false, place: null });
  });

  it('waits for a disconnected racer until their grace period expires', () => {
    const { code, sessions, state } = setupRoom(['Ann', 'Bob']);
    const race = startRace(code);
    m.disconnect('s1');
    typePassage('s0', race.id, race.passage, 30_000);
    expect(state().status).toBe('racing');
    vi.advanceTimersByTime(config.reconnectGraceMs);
    expect(state().status).toBe('lobby');
    expect(state().players.map((p) => p.id)).toEqual([sessions[0].playerId]);
    expect(state().lastResults!.entries[1]).toMatchObject({ left: true, place: null });
  });
});
