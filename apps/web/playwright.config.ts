import { defineConfig } from '@playwright/test';

// E2E runs its own LiveKit + server + web on separate ports (short resume grace), never reusing `pnpm dev`.
const SERVER_PORT = 8788;
const WEB_PORT = 5174;
// Its own LiveKit too (needs `brew install livekit`), on ports that don't clash with `pnpm dev`'s 7880-7882.
const LIVEKIT_PORT = 7890;
const LIVEKIT_CONFIG = `{port: ${LIVEKIT_PORT}, rtc: {tcp_port: 7891, udp_port: 7892, use_external_ip: false, node_ip: 127.0.0.1}}`;

export default defineConfig({
  testDir: 'e2e',
  // Uses the locally installed Google Chrome; set PW_CHANNEL= (empty) to use Playwright's Chromium.
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: process.env.PW_CHANNEL ?? 'chrome',
    // Synthetic camera/mic, auto-accepted prompts.
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
  webServer: [
    {
      command: `livekit-server --dev --bind 127.0.0.1 --config-body "${LIVEKIT_CONFIG}"`,
      url: `http://localhost:${LIVEKIT_PORT}`,
    },
    {
      command: 'pnpm --filter @zoom3d/server start',
      url: `http://localhost:${SERVER_PORT}/health`,
      env: { PORT: String(SERVER_PORT), RESUME_GRACE_MS: '1500', LIVEKIT_URL: `ws://localhost:${LIVEKIT_PORT}` },
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      env: { ZOOM3D_SERVER_URL: `ws://localhost:${SERVER_PORT}` },
    },
  ],
});
