import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
  test: { include: ['src/**/*.test.ts'] },
});
