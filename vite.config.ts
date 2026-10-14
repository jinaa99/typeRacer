import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const serverPort = process.env.PORT ?? '3001';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    port: 5173,
    // In development the Socket.IO server runs separately; proxy it so the
    // client can always connect to its own origin.
    proxy: {
      '/socket.io': { target: `http://localhost:${serverPort}`, ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
