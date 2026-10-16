// The backtick panel's frame rate and render load, counted over half-second windows so the numbers settle instead
// of jumping every frame. Fed once per drawn frame; nothing is allocated per frame.
//
// The render load is the mean time spent drawing a frame, as a share of one screen frame. A screen frame is the
// shortest interval rAF has given since the page loaded: its timestamps fall on the screen's refreshes, so an interval
// is a whole number of them, and the shortest is one, however slow the drawing. (Moved to a slower screen, the load
// reads high until reload.)

/** How long each count runs before the numbers are updated. */
export const FRAME_RATE_WINDOW_MS = 500;
/** A gap between frames this long means rAF was paused (a hidden tab), not a slow frame: the count starts over. */
const PAUSE_MS = 1000;
/** The lowest rates still counted as good and as fair; below fair is poor. */
const GOOD_FPS = 55;
const FAIR_FPS = 30;
/** Render loads (share of a screen frame) up to which drawing counts as good and as fair; from fair up, poor. */
const GOOD_LOAD = 0.5;
const FAIR_LOAD = 0.8;
/** Intervals shorter than this aren't a screen's refresh (none runs past 500 Hz), so they're ignored. */
const MIN_SCREEN_FRAME_MS = 2;

export type FrameRateBand = 'good' | 'fair' | 'poor';

/** Mean drawing time per frame (ms), and its share of one screen frame (1 = all of it). */
export interface RenderLoad {
  ms: number;
  share: number;
}

export interface FrameRateMeter {
  /**
   * Counts one frame drawn at `nowMs` (the performance.now() clock), `intervalMs` after the frame before by rAF's
   * timestamps (0 for the first), whose drawing took `renderMs`.
   */
  frame(nowMs: number, intervalMs: number, renderMs: number): void;
  /** The last full window's rate in frames per second, rounded; null before the first window ends. */
  fps(): number | null;
  /** The last full window's render load (the same object each time); null before the first window ends. */
  renderLoad(): RenderLoad | null;
}

export function frameRateBand(fps: number): FrameRateBand {
  if (fps >= GOOD_FPS) {
    return 'good';
  }
  return fps >= FAIR_FPS ? 'fair' : 'poor';
}

export function renderLoadBand(share: number): FrameRateBand {
  if (share < GOOD_LOAD) {
    return 'good';
  }
  return share < FAIR_LOAD ? 'fair' : 'poor';
}

export function createFrameRateMeter(): FrameRateMeter {
  let windowStartMs: number | null = null;
  let lastFrameMs = 0;
  let frames = 0;
  let renderSumMs = 0;
  let screenFrameMs = Number.POSITIVE_INFINITY;
  let rate: number | null = null;
  const load: RenderLoad = { ms: 0, share: 0 };
  let measured = false;
  return {
    frame(nowMs, intervalMs, renderMs) {
      if (intervalMs >= MIN_SCREEN_FRAME_MS && intervalMs < screenFrameMs) {
        screenFrameMs = intervalMs;
      }
      if (windowStartMs === null || nowMs - lastFrameMs >= PAUSE_MS) {
        windowStartMs = nowMs;
        lastFrameMs = nowMs;
        frames = 0;
        renderSumMs = 0;
        return;
      }
      lastFrameMs = nowMs;
      frames++;
      renderSumMs += renderMs;
      const elapsedMs = nowMs - windowStartMs;
      if (elapsedMs >= FRAME_RATE_WINDOW_MS) {
        rate = Math.round((frames * 1000) / elapsedMs);
        if (Number.isFinite(screenFrameMs)) {
          load.ms = renderSumMs / frames;
          load.share = load.ms / screenFrameMs;
          measured = true;
        }
        windowStartMs = nowMs;
        frames = 0;
        renderSumMs = 0;
      }
    },
    fps: () => rate,
    renderLoad: () => (measured ? load : null),
  };
}
