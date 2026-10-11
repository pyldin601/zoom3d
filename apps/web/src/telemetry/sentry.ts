// Browser error reporting. Off unless the build sets VITE_SENTRY_DSN. Errors only: no tracing, no session replay
// (the screen shows people's names and faces).
import { scrubTelemetry } from './scrub';

export function initSentry(dsn: string | undefined, release: string | undefined): void {
  if (!dsn) {
    return;
  }
  // Its own chunk, fetched only when a DSN is set; errors in the first moments before it loads go unreported.
  import('@sentry/browser').then(
    (Sentry) =>
      Sentry.init({
        dsn,
        release,
        environment: import.meta.env.MODE,
        // Room links and LiveKit tokens turn up in the page URL, breadcrumbs and messages; scrub the whole event.
        beforeSend: (event) => JSON.parse(scrubTelemetry(JSON.stringify(event))),
      }),
    (err) => console.warn('error reporting unavailable', err)
  );
}
