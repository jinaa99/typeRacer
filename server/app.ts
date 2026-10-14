import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import type { ServerToClientEvents } from '../shared/protocol';
import type { ServerConfig } from './config';
import { RoomManager, type Notifier, type Result } from './RoomManager';
import {
  parseCreatePayload,
  parseDifficultyPayload,
  parseInputPayload,
  parseJoinPayload,
  parseReadyPayload,
  parseRejoinPayload,
} from './validation';

/** Maximum events a single socket may send per second before being throttled. */
const MAX_EVENTS_PER_SECOND = 40;

type GameSocket = Socket<Record<string, never>, ServerToClientEvents>;
type AckFn = (response: Result<object>) => void;

export interface GameServer {
  httpServer: HttpServer;
  io: Server<Record<string, never>, ServerToClientEvents>;
  manager: RoomManager;
  close(): Promise<void>;
}

export function createGameServer(config: ServerConfig, clientDir?: string): GameServer {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server<Record<string, never>, ServerToClientEvents>(httpServer, {
    cors: config.corsOrigins ? { origin: config.corsOrigins } : undefined,
    maxHttpBufferSize: 16 * 1024,
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, rooms: manager.roomCount });
  });
  if (clientDir && existsSync(clientDir)) {
    app.use(express.static(clientDir));
    // Single-page app: unknown GET routes return index.html.
    app.get(/^(?!\/socket\.io\/).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  const notifier: Notifier = {
    attach: (socketId, code) => {
      io.sockets.sockets.get(socketId)?.join(code);
    },
    detach: (socketId, code, reason) => {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) return;
      socket.leave(code);
      if (reason) socket.emit('room:removed', { reason });
    },
    roomState: (code, state) => {
      io.to(code).emit('room:state', state);
    },
    progress: (code, update) => {
      io.to(code).volatile.emit('race:progress', update);
    },
    resync: (socketId, payload) => {
      io.to(socketId).emit('race:resync', payload);
    },
  };

  const manager = new RoomManager(config, notifier);

  io.on('connection', (socket: GameSocket) => {
    let windowStart = Date.now();
    let eventsInWindow = 0;
    const allow = (): boolean => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        eventsInWindow = 0;
      }
      return ++eventsInWindow <= MAX_EVENTS_PER_SECOND;
    };

    /**
     * Registers a handler for an untrusted event. The payload is the first
     * non-function argument and the ack is the last argument if it is a
     * function. Handlers return a Result which is passed to the ack.
     */
    const on = (event: string, handler: (payload: unknown) => Result<object> | void) => {
      socket.on(event as never, (...args: unknown[]) => {
        const last = args[args.length - 1];
        const ack = typeof last === 'function' ? (last as AckFn) : null;
        const payload = typeof args[0] === 'function' ? undefined : args[0];
        if (!allow()) {
          ack?.({ ok: false, error: 'Too many requests. Slow down.' });
          return;
        }
        try {
          const result = handler(payload);
          if (result) ack?.(result);
        } catch (err) {
          console.error(`Error handling ${event}:`, err);
          ack?.({ ok: false, error: 'Internal server error.' });
        }
      });
    };

    const invalid: Result = { ok: false, error: 'Invalid request.' };

    on('room:create', (payload) => {
      const p = parseCreatePayload(payload);
      return p ? manager.createRoom(socket.id, p.name) : invalid;
    });
    on('room:join', (payload) => {
      const p = parseJoinPayload(payload);
      return p ? manager.joinRoom(socket.id, p.code, p.name) : invalid;
    });
    on('room:rejoin', (payload) => {
      const p = parseRejoinPayload(payload);
      return p ? manager.rejoinRoom(socket.id, p.code, p.token) : invalid;
    });
    on('room:leave', () => {
      manager.leave(socket.id);
      return { ok: true };
    });
    on('room:ready', (payload) => {
      const p = parseReadyPayload(payload);
      return p ? manager.setReady(socket.id, p.ready) : invalid;
    });
    on('room:difficulty', (payload) => {
      const p = parseDifficultyPayload(payload);
      return p ? manager.setDifficulty(socket.id, p.difficulty) : invalid;
    });
    on('race:start', () => manager.startRace(socket.id));
    on('race:input', (payload) => {
      const p = parseInputPayload(payload);
      if (p) manager.input(socket.id, p.raceId, p.epoch, p.events);
    });

    socket.on('disconnect', () => manager.disconnect(socket.id));
  });

  return {
    httpServer,
    io,
    manager,
    close: async () => {
      manager.shutdown();
      await io.close();
    },
  };
}
