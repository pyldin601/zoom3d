import { RESUME_GRACE_MS } from '@zoom3d/shared';
import { iceConfigFromEnv } from './ice';
import { startServer } from './server';

const port = Number(process.env.PORT ?? 8787);
const graceMs = Number(process.env.RESUME_GRACE_MS ?? RESUME_GRACE_MS);

const server = await startServer({ port, graceMs, ice: iceConfigFromEnv(process.env) });
console.log(`zoom3d server listening on :${server.port}`);
