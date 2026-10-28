// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { showPortalNotice } from './portal-notice';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const notices = (ui: HTMLElement) => [...ui.querySelectorAll('.portal-notice')].map((n) => n.textContent);

test('the notice says what the portals are now, and is gone after 2 s', () => {
  const ui = document.createElement('div');
  showPortalNotice(ui, true);
  expect(notices(ui)).toEqual(['Portals on']);
  vi.advanceTimersByTime(1999);
  expect(notices(ui)).toEqual(['Portals on']);
  vi.advanceTimersByTime(1);
  expect(notices(ui)).toEqual([]);
});

test('a new notice replaces the one showing and restarts the 2 s', () => {
  const ui = document.createElement('div');
  showPortalNotice(ui, true);
  vi.advanceTimersByTime(1500);
  showPortalNotice(ui, false);
  expect(notices(ui)).toEqual(['Portals off']);
  vi.advanceTimersByTime(1500);
  expect(notices(ui)).toEqual(['Portals off']);
  vi.advanceTimersByTime(500);
  expect(notices(ui)).toEqual([]);
});
