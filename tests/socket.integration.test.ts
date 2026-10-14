import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGameServer, type GameServer } from '../server/app';
import { DEFAULT_GAME_CONFIG, type ServerConfig } from '../server/config';
import type {
  ClientToServerEvents,
  JoinResponse,
  ProgressUpdate,
  PublicRoomState,
  ServerToClientEvents,
} from '../shared/protocol';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
type Res<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const config: ServerConfig = {
  ...DEFAULT_GAME_CONFIG,
  port: 0,
  corsOrigins: null,
  countdownMs: 150,
  reconnectGraceMs: 600,
  hostGraceMs: 150,
  raceMaxDurationMs: 10_000,
  progressIntervalMs: 50,
  // Tests type whole passages within milliseconds.
  maxCharsPerSecond: 100_000,
  inputBurstAllowance: 1000,
};

let server: GameServer;
let url: string;
const clients: Client[] = [];

beforeAll(async () => {
  server = createGameServer(config);
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  clients.splice(0).forEach((c) => c.disconnect());
});

async function client(): Promise<Client> {
  const c: Client = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(c);
  await new Promise<void>((resolve, reject) => {
    c.once('connect', () => resolve());
    c.once('connect_error', reject);
  });
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Emits an event with an ack and resolves with the response. */
function call<T = object>(c: Client, event: string, ...args: unknown[]): Promise<Res<T>> {
  return new Promise((resolve) => {
    (c.emit as (ev: string, ...a: unknown[]) => void)(event, ...args, resolve);
  });
}

/** Resolves with the next room state that satisfies `predicate`. */
function waitForState(c: Client, predicate: (s: PublicRoomState) => boolean, timeoutMs = 3000) {
  return new Promise<PublicRoomState>((resolve, reject) => {
    const timer = setTimeout(() => {
      c.off('room:state', handler);
      reject(new Error('Timed out waiting for room state'));
    }, timeoutMs);
    const handler = (s: PublicRoomState) => {
      if (!predicate(s)) return;
      clearTimeout(timer);
      c.off('room:state', handler);
      resolve(s);
    };
    c.on('room:state', handler);
  });
}

async function lobby(names: string[]) {
  const sockets = await Promise.all(names.map(() => client()));
  const created = await call<JoinResponse>(sockets[0], 'room:create', { name: names[0] });
  if (!created.ok) throw new Error(created.error);
  const code = created.session.code;
  const sessions = [created.session];
  for (let i = 1; i < names.length; i++) {
    const joined = await call<JoinResponse>(sockets[i], 'room:join', { code, name: names[i] });
    if (!joined.ok) throw new Error(joined.error);
    sessions.push(joined.session);
  }
  return { sockets, code, sessions };
}

async function readyAll(sockets: Client[]) {
  for (const s of sockets) expect(await call(s, 'room:ready', { ready: true })).toEqual({ ok: true });
}

function typeAll(c: Client, raceId: string, text: string, epoch = 0) {
  for (let i = 0; i < text.length; i += 150) {
    c.emit('race:input', { raceId, epoch, events: [...text.slice(i, i + 150)] });
  }
}

describe('socket server', () => {
  it('runs a full multiplayer race with a shared passage and server-side ranking', async () => {
    const { sockets, sessions } = await lobby(['Ann', 'Bob']);
    const [a, b] = sockets;
    await readyAll(sockets);
    expect(await call(a, 'room:difficulty', { difficulty: 'hard' })).toEqual({ ok: true });

    const countdownA = waitForState(a, (s) => s.status === 'countdown');
    const countdownB = waitForState(b, (s) => s.status === 'countdown');
    expect(await call(a, 'race:start')).toEqual({ ok: true });
    const [sa, sb] = await Promise.all([countdownA, countdownB]);
    expect(sa.race!.passage).toBe(sb.race!.passage);
    expect(sa.race!.startAt).toBe(sb.race!.startAt);
    expect(sa.race!.difficulty).toBe('hard');
    expect(sa.race!.startAt - sa.serverNow).toBeGreaterThan(0);

    const race = sa.race!;
    await waitForState(a, (s) => s.status === 'racing');
    const progress: ProgressUpdate[] = [];
    a.on('race:progress', (u) => progress.push(u));

    // Bob finishes first, then Ann. Client-reported numbers are never sent.
    typeAll(b, race.id, race.passage);
    await sleep(60);
    const done = waitForState(a, (s) => s.status === 'lobby' && s.lastResults !== null);
    typeAll(a, race.id, race.passage);
    const final = await done;

    const entries = final.lastResults!.entries;
    expect(entries.map((e) => e.playerId)).toEqual([sessions[1].playerId, sessions[0].playerId]);
    expect(entries.map((e) => e.place)).toEqual([1, 2]);
    for (const e of entries) {
      expect(e.finished).toBe(true);
      expect(e.accuracy).toBe(100);
      expect(e.completionMs).toBeGreaterThanOrEqual(0);
    }
    expect(entries[0].completionMs!).toBeLessThan(entries[1].completionMs!);
    expect(progress.length).toBeGreaterThan(0);
    expect(final.players.every((p) => !p.ready)).toBe(true);

    // The host can start another race in the same lobby.
    await readyAll(sockets);
    const again = waitForState(b, (s) => s.status === 'countdown');
    expect(await call(a, 'race:start')).toEqual({ ok: true });
    expect((await again).race!.id).not.toBe(race.id);
  });

  it('rejects malformed and unauthorized events without crashing', async () => {
    const { sockets, code } = await lobby(['Ann', 'Bob']);
    const [a, b] = sockets;
    const intruder = await client();

    expect(await call(a, 'room:create', null)).toMatchObject({ ok: false });
    expect(await call(a, 'room:create', { name: '' })).toMatchObject({ ok: false });
    expect(await call(a, 'room:create', { name: 'x'.repeat(500) })).toMatchObject({ ok: false });
    expect(await call(intruder, 'room:join', { code: 'nope', name: 'Eve' })).toMatchObject({ ok: false });
    expect(await call(intruder, 'room:join', { code: 'ZZZZZZ', name: 'Eve' })).toMatchObject({ ok: false });
    expect(await call(intruder, 'room:join', { code, name: 'ann' })).toMatchObject({ ok: false });
    expect(await call(intruder, 'room:rejoin', { code, token: 'x'.repeat(32) })).toMatchObject({ ok: false });
    expect(await call(b, 'room:ready', { ready: 'yes' })).toMatchObject({ ok: false });
    expect(await call(b, 'room:difficulty', { difficulty: 'hard' })).toMatchObject({ ok: false, error: /host/ });
    expect(await call(b, 'race:start')).toMatchObject({ ok: false, error: /host/ });
    expect(await call(intruder, 'race:start')).toMatchObject({ ok: false });

    // Events without acks or with garbage payloads are ignored.
    (b.emit as (ev: string, ...a: unknown[]) => void)('race:input', { raceId: 1, events: 'abc' });
    (b.emit as (ev: string, ...a: unknown[]) => void)('room:ready', { ready: true });
    (b.emit as (ev: string, ...a: unknown[]) => void)('unknown:event', 123);

    // The server is still healthy and the room unchanged.
    const res = await fetch(`${url}/health`);
    expect(res.ok).toBe(true);
    const readyState = waitForState(a, (s) => s.players.length === 2 && s.players.every((p) => p.ready));
    expect(await call(a, 'room:ready', { ready: true })).toEqual({ ok: true });
    const state = await readyState;
    expect(state.hostId).toBe(state.players[0].id);
  });

  it('prevents joining a running lobby and a full lobby', async () => {
    const full = await lobby(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    const ninth = await client();
    expect(await call(ninth, 'room:join', { code: full.code, name: 'P9' })).toMatchObject({ ok: false, error: /full/ });

    const { sockets, code } = await lobby(['Ann', 'Bob']);
    await readyAll(sockets);
    expect(await call(sockets[0], 'race:start')).toEqual({ ok: true });
    const late = await client();
    expect(await call(late, 'room:join', { code, name: 'Late' })).toMatchObject({ ok: false, error: /in progress/ });
  });

  it('transfers host when the host disconnects and lets players rejoin by token', async () => {
    const { sockets, code, sessions } = await lobby(['Ann', 'Bob', 'Cid']);
    const [a, b, c] = sockets;

    const transferred = waitForState(b, (s) => s.hostId === sessions[1].playerId);
    a.disconnect();
    const state = await transferred;
    expect(state.players.find((p) => p.id === sessions[0].playerId)!.connected).toBe(false);

    // Ann comes back (e.g. after a refresh) as a regular player.
    const a2 = await client();
    const rejoined = await call<JoinResponse>(a2, 'room:rejoin', { code, token: sessions[0].token });
    expect(rejoined).toMatchObject({ ok: true, session: { playerId: sessions[0].playerId } });
    if (rejoined.ok) expect(rejoined.state.hostId).toBe(sessions[1].playerId);

    // Cid drops and does not return; the seat is released after the grace period.
    const gone = waitForState(b, (s) => s.players.length === 2, 3000);
    c.disconnect();
    await gone;
    expect(await call(b, 'race:start')).toMatchObject({ ok: false, error: /ready/ });
  });

  it('resumes a race after reconnecting mid-race', async () => {
    const { sockets, code, sessions } = await lobby(['Ann', 'Bob']);
    const [a, b] = sockets;
    await readyAll(sockets);
    const racing = waitForState(b, (s) => s.status === 'racing');
    await call(a, 'race:start');
    const race = (await racing).race!;

    typeAll(b, race.id, race.passage.slice(0, 12));
    await sleep(50);
    b.disconnect();
    const b2 = await client();
    const res = await call<JoinResponse>(b2, 'room:rejoin', { code, token: sessions[1].token });
    if (!res.ok) throw new Error(res.error);
    expect(res.resync).toMatchObject({ raceId: race.id, typed: race.passage.slice(0, 12) });

    const done = waitForState(a, (s) => s.status === 'lobby' && s.lastResults !== null);
    typeAll(b2, race.id, race.passage.slice(12), res.resync!.epoch);
    typeAll(a, race.id, race.passage);
    const results = (await done).lastResults!;
    expect(results.entries.every((e) => e.finished)).toBe(true);
  });
});
