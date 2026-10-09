import { defineConfig } from 'vitest/config';
import { mediapipeWasm } from './mediapipe-wasm';

export default defineConfig({
  plugins: [mediapipeWasm()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/ws': { target: process.env.ZOOM3D_SERVER_URL ?? 'ws://localhost:8787', ws: true } },
  },
  test: { include: ['src/**/*.test.ts'] },
});
