import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Uses the locally installed Google Chrome; set PW_CHANNEL= (empty) to use Playwright's Chromium.
  use: { baseURL: 'http://localhost:5173', channel: process.env.PW_CHANNEL ?? 'chrome' },
  webServer: [
    {
      command: 'pnpm --filter @zoom3d/server start',
      url: 'http://localhost:8787/health',
      env: { RESUME_GRACE_MS: '1500' },
      reuseExistingServer: !process.env.CI,
    },
    { command: 'pnpm dev', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI },
  ],
});
