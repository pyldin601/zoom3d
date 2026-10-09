// rAF stops in hidden tabs; keep spatial audio (gains, pan, new voices) updating from a timer meanwhile.
export const HIDDEN_TICK_MS = 100;

export function startHiddenTicker(tick: () => void, isHidden: () => boolean, intervalMs = HIDDEN_TICK_MS): () => void {
  const id = setInterval(() => {
    if (isHidden()) tick();
  }, intervalMs);
  return () => clearInterval(id);
}
