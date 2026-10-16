// Frames per second for the backtick panel's renderer section, counted over half-second windows so the number
// settles instead of jumping every frame. Fed once per drawn frame; nothing is allocated per frame.

/** How long each count runs before the rate is updated. */
export const FRAME_RATE_WINDOW_MS = 500;
/** A gap between frames this long means rAF was paused (a hidden tab), not a slow frame: the count starts over. */
const PAUSE_MS = 1000;
/** The lowest rates still counted as good and as fair; below fair is poor. */
const GOOD_FPS = 55;
const FAIR_FPS = 30;

export type FrameRateBand = 'good' | 'fair' | 'poor';

export interface FrameRateMeter {
  /** Counts one frame drawn at `nowMs` (the performance.now() clock). */
  frame(nowMs: number): void;
  /** The last full window's rate in frames per second, rounded; null before the first window ends. */
  fps(): number | null;
}

export function frameRateBand(fps: number): FrameRateBand {
  if (fps >= GOOD_FPS) {
    return 'good';
  }
  return fps >= FAIR_FPS ? 'fair' : 'poor';
}

export function createFrameRateMeter(): FrameRateMeter {
  let windowStartMs: number | null = null;
  let lastFrameMs = 0;
  let frames = 0;
  let rate: number | null = null;
  return {
    frame(nowMs) {
      if (windowStartMs === null || nowMs - lastFrameMs >= PAUSE_MS) {
        windowStartMs = nowMs;
        lastFrameMs = nowMs;
        frames = 0;
        return;
      }
      lastFrameMs = nowMs;
      frames++;
      const elapsedMs = nowMs - windowStartMs;
      if (elapsedMs >= FRAME_RATE_WINDOW_MS) {
        rate = Math.round((frames * 1000) / elapsedMs);
        windowStartMs = nowMs;
        frames = 0;
      }
    },
    fps: () => rate,
  };
}
