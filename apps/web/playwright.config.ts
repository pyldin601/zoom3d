import { defineConfig } from '@playwright/test';

// E2E runs its own server + web pair on separate ports (short resume grace), never reusing `pnpm dev`.
const SERVER_PORT = 8788;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: 'e2e',
  // Uses the locally installed Google Chrome; set PW_CHANNEL= (empty) to use Playwright's Chromium.
  use: { baseURL: `http://localhost:${WEB_PORT}`, channel: process.env.PW_CHANNEL ?? 'chrome' },
  webServer: [
    {
      command: 'pnpm --filter @zoom3d/server start',
      url: `http://localhost:${SERVER_PORT}/health`,
      env: { PORT: String(SERVER_PORT), RESUME_GRACE_MS: '1500' },
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      env: { ZOOM3D_SERVER_URL: `ws://localhost:${SERVER_PORT}` },
    },
  ],
});
