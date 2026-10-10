import * as Sentry from '@sentry/node';
import { RESUME_GRACE_MS } from '@zoom3d/shared';
import { iceConfigFromEnv } from './ice';
import { createLogger, type Logger, parseLogLevel } from './log';
import { startServer } from './server';

// Errors only: no tracing, so the runtime instrumentation hooks (which a bundle can't load anyway) stay off.
// The SDK reads SENTRY_RELEASE (baked into the image) and SENTRY_ENVIRONMENT itself.
const sentry = Boolean(process.env.SENTRY_DSN);
if (sentry) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, enableRuntimeChannelInjection: false });
}

const base = createLogger({ level: parseLogLevel(process.env.LOG_LEVEL) });
const log: Logger = {
  ...base,
  error(msg, fields) {
    base.error(msg, fields);
    if (sentry) {
      if (fields?.err instanceof Error) {
        Sentry.captureException(fields.err, { extra: { msg, ...fields } });
      } else {
        Sentry.captureMessage(msg, { level: 'error', extra: fields });
      }
    }
  },
};

// Sentry's own handlers capture these first; ours logs, flushes and exits like Node's default would.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    base.error(event, { err });
    void Sentry.flush(2000).finally(() => process.exit(1));
  });
}

const port = Number(process.env.PORT ?? 8787);
const graceMs = Number(process.env.RESUME_GRACE_MS ?? RESUME_GRACE_MS);

// With Recreate deploys, a file on a persistent volume carries the rooms across a restart.
const stateFile = process.env.STATE_FILE || undefined;

const server = await startServer({ port, graceMs, ice: iceConfigFromEnv(process.env), stateFile, log });
log.info('server_listening', { port: server.port, stateFile: stateFile ?? null, sentry });

// Containers send SIGTERM on stop; PID 1 gets no default handler, so close explicitly.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info('shutting_down', { signal });
    void server
      .close()
      .then(() => Sentry.flush(2000))
      .then(() => process.exit(0));
  });
}
