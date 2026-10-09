import { RESUME_GRACE_MS } from '@zoom3d/shared';
import { iceConfigFromEnv } from './ice';
import { startServer } from './server';

const port = Number(process.env.PORT ?? 8787);
const graceMs = Number(process.env.RESUME_GRACE_MS ?? RESUME_GRACE_MS);

// With Recreate deploys, a file on a persistent volume carries the rooms across a restart.
const stateFile = process.env.STATE_FILE || undefined;

const server = await startServer({ port, graceMs, ice: iceConfigFromEnv(process.env), stateFile });
console.log(`zoom3d server listening on :${server.port}`);

// Containers send SIGTERM on stop; PID 1 gets no default handler, so close explicitly.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
