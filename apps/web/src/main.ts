// The page's entry point.
import { createGame } from './game/game';
import { findPageElements, readPageFlags } from './game/page';
import { initAnalytics } from './telemetry/analytics';
import { initSentry } from './telemetry/sentry';
import { parseRoute } from './ui/route';

function main(): void {
  // Before anything else, so errors and events from the start are caught.
  initSentry(import.meta.env.VITE_SENTRY_DSN, import.meta.env.VITE_RELEASE);
  initAnalytics(import.meta.env.VITE_AMPLITUDE_API_KEY, import.meta.env.VITE_RELEASE);
  const flags = readPageFlags(location.search, (query) => matchMedia(query).matches);
  document.documentElement.classList.toggle('touch', flags.touch);
  const game = createGame(findPageElements(document), flags);
  if (import.meta.env.DEV) {
    Object.assign(window, { __game: game.forTests });
  }
  game.show(parseRoute(location.pathname));
}

main();
