import { expect, test } from 'vitest';
import { createFrameRateMeter, FRAME_RATE_WINDOW_MS, frameRateBand, renderLoadBand } from './frame-rate';

/**
 * Feeds `meter` frames every `intervalMs` from `fromMs` up to and including `toMs`, each drawn in `renderMs`. The
 * first one's interval is `firstIntervalMs` (0 for the very first frame, as startLoop gives it).
 */
function run(
  meter: ReturnType<typeof createFrameRateMeter>,
  fromMs: number,
  toMs: number,
  intervalMs: number,
  renderMs = 0,
  firstIntervalMs = intervalMs
): void {
  for (let t = fromMs; t <= toMs + 1e-6; t += intervalMs) {
    meter.frame(t, t === fromMs ? firstIntervalMs : intervalMs, renderMs);
  }
}

test('there is no rate before the first full window', () => {
  const meter = createFrameRateMeter();
  expect(meter.fps()).toBeNull();
  run(meter, 0, FRAME_RATE_WINDOW_MS - 20, 1000 / 60, 0, 0);
  expect(meter.fps()).toBeNull();
});

test('a steady 60 Hz loop reads 60 fps after one window', () => {
  const meter = createFrameRateMeter();
  run(meter, 0, FRAME_RATE_WINDOW_MS, 1000 / 60, 0, 0);
  expect(meter.fps()).toBe(60);
});

test('the rate follows the loop from one window to the next', () => {
  const meter = createFrameRateMeter();
  run(meter, 0, FRAME_RATE_WINDOW_MS, 1000 / 60, 0, 0);
  run(meter, FRAME_RATE_WINDOW_MS + 1000 / 30, 2 * FRAME_RATE_WINDOW_MS, 1000 / 30);
  expect(meter.fps()).toBe(30);
});

test('a hidden tab pausing the loop does not read as a slow frame', () => {
  const meter = createFrameRateMeter();
  run(meter, 0, FRAME_RATE_WINDOW_MS, 1000 / 60, 0, 0);
  // rAF stops while the tab is hidden; the first frames back start a fresh count.
  run(meter, 10_000, 10_000 + FRAME_RATE_WINDOW_MS, 1000 / 60, 0, 9500);
  expect(meter.fps()).toBe(60);
});

test('rates fall into good, fair and poor bands', () => {
  expect(frameRateBand(60)).toBe('good');
  expect(frameRateBand(55)).toBe('good');
  expect(frameRateBand(54)).toBe('fair');
  expect(frameRateBand(30)).toBe('fair');
  expect(frameRateBand(29)).toBe('poor');
});

test('there is no render load before the first full window', () => {
  const meter = createFrameRateMeter();
  expect(meter.renderLoad()).toBeNull();
  run(meter, 0, FRAME_RATE_WINDOW_MS - 20, 1000 / 60, 4, 0);
  expect(meter.renderLoad()).toBeNull();
});

test('the render load is the mean render time and its share of one screen frame', () => {
  const meter = createFrameRateMeter();
  // 120 Hz: an 8.3 ms frame, 2.5 ms of it drawing. (Runs go past a window: 60 steps of 1000/120 fall short of 500.)
  run(meter, 0, 600, 1000 / 120, 2.5, 0);
  const load = meter.renderLoad();
  expect(load?.ms).toBeCloseTo(2.5, 6);
  expect(load?.share).toBeCloseTo(0.3, 6);
});

test('drawing slower than the screen reads over 100%, not as a slower screen', () => {
  const meter = createFrameRateMeter();
  run(meter, 0, 600, 1000 / 120, 2, 0);
  // Now each frame takes 12 ms to draw: the 120 Hz screen gets a new frame every other refresh.
  run(meter, 600 + 1000 / 60, 2000, 1000 / 60, 12);
  expect(meter.fps()).toBe(60);
  expect(meter.renderLoad()?.share).toBeCloseTo(12 / (1000 / 120), 6);
});

test('render loads fall into good, fair and poor bands', () => {
  expect(renderLoadBand(0.2)).toBe('good');
  expect(renderLoadBand(0.49)).toBe('good');
  expect(renderLoadBand(0.5)).toBe('fair');
  expect(renderLoadBand(0.79)).toBe('fair');
  expect(renderLoadBand(0.8)).toBe('poor');
  expect(renderLoadBand(1.4)).toBe('poor');
});
