import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createGameServer } from '../server/app';
import { DEFAULT_GAME_CONFIG, loadConfig, parseCorsOrigins } from '../server/config';

describe('parseCorsOrigins', () => {
  it('returns null when unset or empty', () => {
    expect(parseCorsOrigins(undefined)).toBeNull();
    expect(parseCorsOrigins('  , ')).toBeNull();
  });

  it('keeps exact origins and strips trailing slashes', () => {
    expect(parseCorsOrigins('https://a.vercel.app/, http://localhost:5173')).toEqual([
      'https://a.vercel.app',
      'http://localhost:5173',
    ]);
  });

  it('turns * into a pattern for preview deployments', () => {
    const [pattern] = parseCorsOrigins('https://typeracer-*.vercel.app')!;
    expect(pattern).toBeInstanceOf(RegExp);
    const re = pattern as RegExp;
    expect(re.test('https://typeracer-git-main-me.vercel.app')).toBe(true);
    expect(re.test('https://typeracer-abc123.vercel.app')).toBe(true);
    expect(re.test('https://typeracer-x.vercel.app.evil.com')).toBe(false);
    expect(re.test('https://evil.com/typeracer-x.vercel.app')).toBe(false);
    expect(re.test('http://typeracer-x.vercel.app')).toBe(false);
    expect(re.test('https://typeracer-a.b.vercel.app')).toBe(false);
  });

  it('is used by loadConfig', () => {
    expect(loadConfig({ CORS_ORIGIN: 'https://x.dev' }).corsOrigins).toEqual(['https://x.dev']);
    expect(loadConfig({}).corsOrigins).toBeNull();
  });
});

describe('CORS on the realtime server', () => {
  it('allows configured origins and rejects others', async () => {
    const server = createGameServer({
      ...DEFAULT_GAME_CONFIG,
      port: 0,
      corsOrigins: parseCorsOrigins('https://typeracer.vercel.app,https://typeracer-*.vercel.app'),
    });
    await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
    const base = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
    const handshake = (origin: string) =>
      fetch(`${base}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } }).then((r) =>
        r.headers.get('access-control-allow-origin'),
      );
    try {
      expect(await handshake('https://typeracer.vercel.app')).toBe('https://typeracer.vercel.app');
      expect(await handshake('https://typeracer-git-dev-me.vercel.app')).toBe('https://typeracer-git-dev-me.vercel.app');
      expect(await handshake('https://evil.example.com')).toBeNull();
      // Without a bundled client the root explains what this server is.
      expect(await (await fetch(base)).text()).toMatch(/realtime server/);
    } finally {
      await server.close();
    }
  });
});
