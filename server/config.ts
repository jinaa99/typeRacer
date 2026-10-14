export interface GameConfig {
  countdownMs: number;
  /** How long a disconnected player keeps their slot before being removed. */
  reconnectGraceMs: number;
  /** How long a disconnected host keeps host privileges. */
  hostGraceMs: number;
  raceMaxDurationMs: number;
  progressIntervalMs: number;
  maxRooms: number;
  /** Upper bound on sustained typing speed, in characters per second. */
  maxCharsPerSecond: number;
  /** Extra characters allowed on top of the speed bound (buffering, bursts). */
  inputBurstAllowance: number;
}

export interface ServerConfig extends GameConfig {
  port: number;
  corsOrigins: string[] | null;
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  countdownMs: 3000,
  reconnectGraceMs: 30_000,
  hostGraceMs: 5000,
  raceMaxDurationMs: 600_000,
  progressIntervalMs: 250,
  maxRooms: 1000,
  maxCharsPerSecond: 25,
  inputBurstAllowance: 40,
};

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Environment variable ${key} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const d = DEFAULT_GAME_CONFIG;
  const cors = env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    port: intFromEnv(env, 'PORT', 3001, 1),
    corsOrigins: cors && cors.length > 0 ? cors : null,
    countdownMs: intFromEnv(env, 'COUNTDOWN_MS', d.countdownMs),
    reconnectGraceMs: intFromEnv(env, 'RECONNECT_GRACE_MS', d.reconnectGraceMs),
    hostGraceMs: intFromEnv(env, 'HOST_GRACE_MS', d.hostGraceMs),
    raceMaxDurationMs: intFromEnv(env, 'RACE_MAX_DURATION_MS', d.raceMaxDurationMs, 1000),
    progressIntervalMs: intFromEnv(env, 'PROGRESS_INTERVAL_MS', d.progressIntervalMs, 50),
    maxRooms: intFromEnv(env, 'MAX_ROOMS', d.maxRooms, 1),
    maxCharsPerSecond: d.maxCharsPerSecond,
    inputBurstAllowance: d.inputBurstAllowance,
  };
}
