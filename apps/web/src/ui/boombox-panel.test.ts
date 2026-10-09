// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { formatTime, PROGRESS_MS, showBoomboxPanel } from './boombox-panel';

let root: HTMLElement;
let progress: { current: number; duration: number };
let onVolume: ReturnType<typeof vi.fn<(v: number) => void>>;
let onSeek: ReturnType<typeof vi.fn<(s: number) => void>>;
let onStop: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.getElementById('ui') as HTMLElement;
  progress = { current: 0, duration: 0 };
  onVolume = vi.fn<(v: number) => void>();
  onSeek = vi.fn<(s: number) => void>();
  onStop = vi.fn<() => void>();
});
afterEach(() => {
  vi.useRealTimers();
});

const show = (title = '<b>Song</b>.mp3', volume = 0.8) =>
  showBoomboxPanel(root, { title, volume, progress: () => progress, onVolume, onSeek, onStop });
const slider = (label: string) =>
  [...root.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector('input') as HTMLInputElement;

test('formatTime shows minutes and seconds', () => {
  expect(formatTime(0)).toBe('0:00');
  expect(formatTime(65.9)).toBe('1:05');
  expect(formatTime(3725)).toBe('62:05');
  expect(formatTime(Number.NaN)).toBe('0:00');
});

test('shows the track name as text, and the volume in percent', () => {
  show();
  const panel = root.querySelector('.boombox-panel') as HTMLElement;
  expect(panel.textContent).toContain('<b>Song</b>.mp3');
  expect(panel.querySelector('b')).toBeNull();
  expect(slider('Volume').value).toBe('80');
});

test('the volume slider reports 0..1', () => {
  show();
  const volume = slider('Volume');
  volume.value = '30';
  volume.dispatchEvent(new Event('input'));
  expect(onVolume).toHaveBeenLastCalledWith(0.3);
});

test('the progress bar follows the track', () => {
  show();
  progress = { current: 65, duration: 200 };
  vi.advanceTimersByTime(PROGRESS_MS);
  const bar = slider('Progress');
  expect([bar.max, bar.value]).toEqual(['200', '65']);
  expect(root.textContent).toContain('1:05 / 3:20');
});

test('dragging the progress bar seeks on release, and the bar is not reset while dragging', () => {
  show();
  progress = { current: 10, duration: 200 };
  vi.advanceTimersByTime(PROGRESS_MS);
  const bar = slider('Progress');
  bar.value = '150';
  bar.dispatchEvent(new Event('input'));
  vi.advanceTimersByTime(PROGRESS_MS);
  expect(bar.value).toBe('150');
  expect(root.textContent).toContain('2:30 / 3:20');
  expect(onSeek).not.toHaveBeenCalled();
  bar.dispatchEvent(new Event('change'));
  expect(onSeek).toHaveBeenLastCalledWith(150);
  progress = { current: 151, duration: 200 };
  vi.advanceTimersByTime(PROGRESS_MS);
  expect(bar.value).toBe('151');
});

test('Stop calls onStop', () => {
  show();
  (root.querySelector('button') as HTMLButtonElement).click();
  expect(onStop).toHaveBeenCalledTimes(1);
});

test('showing null removes the panel and stops updating it', () => {
  show();
  const read = vi.fn(() => progress);
  showBoomboxPanel(root, { title: 'x', volume: 1, progress: read, onVolume, onSeek, onStop });
  expect(root.querySelectorAll('.boombox-panel')).toHaveLength(1);
  showBoomboxPanel(root, null);
  expect(root.querySelector('.boombox-panel')).toBeNull();
  read.mockClear();
  vi.advanceTimersByTime(PROGRESS_MS * 3);
  expect(read).not.toHaveBeenCalled();
});
