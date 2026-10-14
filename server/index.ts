import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './app';
import { loadConfig } from './config';

const config = loadConfig();
// The production bundle lives in dist/server; the built client in dist/client.
const clientDir = process.env.CLIENT_DIST_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
const server = createGameServer(config, clientDir);

server.httpServer.listen(config.port, () => {
  console.log(`Typing race server listening on http://localhost:${config.port}`);
});

const shutdown = () => {
  server.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
