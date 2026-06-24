import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    proxy: {
      // dev: forward the game WebSocket to the authoritative Bun server
      '/ws': { target: 'ws://localhost:3801', ws: true },
    },
  },
});
