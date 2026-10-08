import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HIDDEN_TICK_MS, startHiddenTicker } from './ticker';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('ticks on a timer only while the page is hidden', () => {
  let hidden = false;
  const tick = vi.fn();
  const stop = startHiddenTicker(tick, () => hidden);
  vi.advanceTimersByTime(HIDDEN_TICK_MS * 3);
  expect(tick).not.toHaveBeenCalled();
  hidden = true;
  vi.advanceTimersByTime(HIDDEN_TICK_MS * 3);
  expect(tick).toHaveBeenCalledTimes(3);
  stop();
  vi.advanceTimersByTime(HIDDEN_TICK_MS * 3);
  expect(tick).toHaveBeenCalledTimes(3);
});
