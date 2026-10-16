import { expect, test } from 'vitest';
import { createFrameRateMeter, FRAME_RATE_WINDOW_MS, frameRateBand } from './frame-rate';

/** Feeds `meter` frames every `intervalMs` from `fromMs` up to and including `toMs`. */
function run(meter: ReturnType<typeof createFrameRateMeter>, fromMs: number, toMs: number, intervalMs: number): void {
  for (let t = fromMs; t <= toMs + 1e-6; t += intervalMs) {
    meter.frame(t);
  }
}

test('there is no rate before the first full window', () => {
  const meter = createFrameRateMeter();
  expect(meter.fps()).toBeNull();
  run(meter, 0, FRAME_RATE_WINDOW_MS - 20, 1000 / 60);
  expect(meter.fps()).toBeNull();
});

test('a steady 60 Hz loop reads 60 fps after one window', () => {
  const meter = createFrameRateMeter();
  run(meter, 0, FRAME_RATE_WINDOW_MS, 1000 / 60);
  expect(meter.fps()).toBe(60);
});

test('the rate follows the loop from one window to the next', () => {
  const meter = createFrameRateMeter();
  run(meter, 0, FRAME_RATE_WINDOW_MS, 1000 / 60);
  run(meter, FRAME_RATE_WINDOW_MS + 1000 / 30, 2 * FRAME_RATE_WINDOW_MS, 1000 / 30);
  expect(meter.fps()).toBe(30);
});

test('a hidden tab pausing the loop does not read as a slow frame', () => {
  const meter = createFrameRateMeter();
  run(meter, 0, FRAME_RATE_WINDOW_MS, 1000 / 60);
  // rAF stops while the tab is hidden; the first frames back start a fresh count.
  run(meter, 10_000, 10_000 + FRAME_RATE_WINDOW_MS, 1000 / 60);
  expect(meter.fps()).toBe(60);
});

test('rates fall into good, fair and poor bands', () => {
  expect(frameRateBand(60)).toBe('good');
  expect(frameRateBand(55)).toBe('good');
  expect(frameRateBand(54)).toBe('fair');
  expect(frameRateBand(30)).toBe('fair');
  expect(frameRateBand(29)).toBe('poor');
});
