import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, Session } from '../../shared/protocol';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GameSocket | null = null;

/** Shared Socket.IO connection. Connects to VITE_SERVER_URL or this origin. */
export function getSocket(): GameSocket {
  if (!socket) {
    const url = import.meta.env.VITE_SERVER_URL as string | undefined;
    socket = url ? io(url, { autoConnect: false }) : io({ autoConnect: false });
  }
  return socket;
}

// sessionStorage is per tab, so two tabs are two players, while a refresh
// keeps the same seat.
const SESSION_KEY = 'typerace.session';

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    return typeof s.code === 'string' && typeof s.playerId === 'string' && typeof s.token === 'string'
      ? (s as Session)
      : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable: reconnect after refresh won't work, gameplay still does.
  }
}
