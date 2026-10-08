import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Uses the locally installed Google Chrome; set PW_CHANNEL= (empty) to use Playwright's Chromium.
  use: { baseURL: 'http://localhost:5173', channel: process.env.PW_CHANNEL ?? 'chrome' },
  webServer: { command: 'pnpm dev', url: 'http://localhost:5173', reuseExistingServer: true },
});
