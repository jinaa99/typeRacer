import { useCallback, useEffect, useRef, useState } from 'react';
import type { Difficulty } from '../../shared/passages';
import type {
  JoinResponse,
  ProgressEntry,
  PublicRoomState,
  ResyncPayload,
  Session,
} from '../../shared/protocol';
import { getSocket, loadSession, saveSession } from './socket';

type AckResponse<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Acks are lost if the connection drops mid-request; give up after this long. */
const ACK_TIMEOUT_MS = 8000;
const TIMEOUT_ERROR = 'The server did not respond. Please try again.';
/** Number of recent server timestamps used to estimate the clock offset. */
const OFFSET_SAMPLES = 15;

export interface RoomHook {
  connected: boolean;
  busy: boolean;
  error: string | null;
  /** Message shown after the player was removed from a room. */
  notice: string | null;
  session: Session | null;
  room: PublicRoomState | null;
  progress: Map<string, ProgressEntry>;
  /** Latest authoritative typing state for this player (rejoin or rejected input). */
  resync: ResyncPayload | null;
  /** Estimated server time minus local time, in ms. */
  clockOffset: number;
  createRoom(name: string): void;
  joinRoom(code: string, name: string): void;
  leaveRoom(): void;
  setReady(ready: boolean): void;
  setDifficulty(difficulty: Difficulty): void;
  startRace(): void;
  sendInput(raceId: string, epoch: number, events: string[]): void;
  clearError(): void;
}

const timedOut = { ok: false as const, error: TIMEOUT_ERROR };

export function useRoom(): RoomHook {
  const socket = getSocket();
  const [connected, setConnected] = useState(socket.connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [room, setRoom] = useState<PublicRoomState | null>(null);
  const [progress, setProgress] = useState<Map<string, ProgressEntry>>(new Map());
  const [resync, setResync] = useState<ResyncPayload | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const sessionRef = useRef(session);
  // Offsets estimated from server timestamps are always too low by the one-way
  // latency, so the largest recent sample is the most accurate one. Only recent
  // samples count, so a local clock change is picked up again.
  const offsetSamples = useRef<number[]>([]);

  const observeServerTime = useCallback((serverNow: number) => {
    const samples = offsetSamples.current;
    samples.push(serverNow - Date.now());
    if (samples.length > OFFSET_SAMPLES) samples.shift();
    setClockOffset(Math.max(...samples));
  }, []);

  const applyRoomState = useCallback(
    (state: PublicRoomState) => {
      observeServerTime(state.serverNow);
      setRoom(state);
      if (!state.race) setProgress(new Map());
    },
    [observeServerTime],
  );

  const updateSession = useCallback((s: Session | null) => {
    sessionRef.current = s;
    saveSession(s);
    setSession(s);
  }, []);

  const handleJoin = useCallback(
    (res: AckResponse<JoinResponse>, fromRejoin: boolean) => {
      setBusy(false);
      if (!res.ok) {
        // A timed-out rejoin keeps the session; it is retried on the next connect.
        if (fromRejoin && res.error !== TIMEOUT_ERROR) {
          updateSession(null);
          setRoom(null);
          setNotice(res.error);
        } else {
          setError(res.error);
        }
        return;
      }
      setError(null);
      setNotice(null);
      updateSession(res.session);
      applyRoomState(res.state);
      setResync(res.resync);
    },
    [applyRoomState, updateSession],
  );

  useEffect(() => {
    const rejoin = () => {
      const s = sessionRef.current;
      if (!s) return;
      setBusy(true);
      socket
        .timeout(ACK_TIMEOUT_MS)
        .emit('room:rejoin', { code: s.code, token: s.token }, (err, res) => handleJoin(err ? timedOut : res, true));
    };
    const onConnect = () => {
      setConnected(true);
      // Errors from before the reconnect no longer apply.
      setError(null);
      rejoin();
    };
    const onDisconnect = () => setConnected(false);
    const onState = (state: PublicRoomState) => {
      if (state.code === sessionRef.current?.code) applyRoomState(state);
    };
    const onProgress = (update: { serverNow: number; players: ProgressEntry[] }) => {
      observeServerTime(update.serverNow);
      setProgress(new Map(update.players.map((p) => [p.playerId, p])));
    };
    const onResync = (payload: ResyncPayload) => setResync(payload);
    const onRemoved = ({ reason }: { reason: string }) => {
      updateSession(null);
      setRoom(null);
      setNotice(reason);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room:state', onState);
    socket.on('race:progress', onProgress);
    socket.on('race:resync', onResync);
    socket.on('room:removed', onRemoved);
    if (socket.connected) rejoin();
    else socket.connect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
        socket.off('room:state', onState);
      socket.off('race:progress', onProgress);
      socket.off('race:resync', onResync);
      socket.off('room:removed', onRemoved);
    };
  }, [socket, handleJoin, applyRoomState, observeServerTime, updateSession]);

  const simpleAck = (err: Error | null, res: AckResponse) => {
    if (err) setError(TIMEOUT_ERROR);
    else if (!res.ok) setError(res.error);
  };

  return {
    connected,
    busy,
    error,
    notice,
    session,
    room,
    progress,
    resync,
    clockOffset,
    createRoom(name) {
      setBusy(true);
      setError(null);
      socket.timeout(ACK_TIMEOUT_MS).emit('room:create', { name }, (err, res) => handleJoin(err ? timedOut : res, false));
    },
    joinRoom(code, name) {
      setBusy(true);
      setError(null);
      socket
        .timeout(ACK_TIMEOUT_MS)
        .emit('room:join', { code, name }, (err, res) => handleJoin(err ? timedOut : res, false));
    },
    leaveRoom() {
      socket.emit('room:leave');
      updateSession(null);
      setRoom(null);
      setResync(null);
      setProgress(new Map());
      setNotice(null);
      setError(null);
    },
    setReady(ready) {
      socket.timeout(ACK_TIMEOUT_MS).emit('room:ready', { ready }, simpleAck);
    },
    setDifficulty(difficulty) {
      socket.timeout(ACK_TIMEOUT_MS).emit('room:difficulty', { difficulty }, simpleAck);
    },
    startRace() {
      socket.timeout(ACK_TIMEOUT_MS).emit('race:start', simpleAck);
    },
    sendInput(raceId, epoch, events) {
      socket.emit('race:input', { raceId, epoch, events });
    },
    clearError() {
      setError(null);
    },
  };
}
