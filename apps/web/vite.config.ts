import { defineConfig } from 'vitest/config';
import { mediapipeWasm } from './mediapipe-wasm.ts';

const SERVER_URL = process.env.ZOOM3D_SERVER_URL ?? 'ws://localhost:8787';

export default defineConfig({
  plugins: [mediapipeWasm()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: SERVER_URL, ws: true },
      '/avatar': { target: SERVER_URL.replace(/^ws/, 'http') },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
