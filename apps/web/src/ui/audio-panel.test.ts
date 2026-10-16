// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { type AudioPanelOptions, setAudioPanelBoombox, showAudioPanel } from './audio-panel';
import { PROGRESS_MS } from './boombox-panel';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.getElementById('ui') as HTMLElement;
});

const options = (overrides: Partial<AudioPanelOptions> = {}): AudioPanelOptions => ({
  frameRate: () => null,
  render: { settings: { reflections: 'both' }, onChange: () => {} },
  ...overrides,
});

test('the frame rate comes first, then the renderer options, with no audio tuning or speaking list', () => {
  showAudioPanel(root, options());
  const column = root.querySelector('.audio-panel > .renderer') as HTMLElement;
  expect(column.firstElementChild?.className).toBe('frame-rate');
  expect(column.textContent).toContain('Reflections');
  expect(root.querySelector('input[type=range]')).toBeNull();
  expect(root.querySelector('.levels')).toBeNull();
});

test('the frame rate is refreshed while the panel is open and coloured by band', () => {
  vi.useFakeTimers();
  try {
    let fps: number | null = null;
    showAudioPanel(root, options({ frameRate: () => fps }));
    const rate = root.querySelector('.frame-rate span') as HTMLElement;
    expect(rate.parentElement?.textContent).toContain('Frame rate');
    expect(rate.textContent).toBe('–');
    fps = 42;
    vi.advanceTimersByTime(1000);
    expect(rate.textContent).toBe('42 fps');
    expect(rate.className).toBe('fair');
    fps = 60;
    vi.advanceTimersByTime(1000);
    expect(rate.className).toBe('good');
  } finally {
    vi.useRealTimers();
  }
});

test('closing the panel stops refreshing the frame rate', () => {
  vi.useFakeTimers();
  try {
    const frameRate = vi.fn(() => 60);
    showAudioPanel(root, options({ frameRate }));
    showAudioPanel(root, null);
    frameRate.mockClear();
    vi.advanceTimersByTime(1000);
    expect(frameRate).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('null removes the panel', () => {
  showAudioPanel(root, options());
  expect(root.querySelector('.audio-panel')).not.toBeNull();
  showAudioPanel(root, null);
  expect(root.querySelector('.audio-panel')).toBeNull();
});

test('the renderer section switches reflections', () => {
  const onRender = vi.fn();
  showAudioPanel(root, options({ render: { settings: { reflections: 'both' }, onChange: onRender } }));
  expect(root.textContent).toContain('Renderer');
  const select = root.querySelector('.renderer select') as HTMLSelectElement;
  expect(select.parentElement?.textContent).toContain('Reflections');
  expect(select.value).toBe('both');
  expect([...select.options].map((o) => o.value)).toEqual(['none', 'walls', 'both']);
  select.value = 'walls';
  select.dispatchEvent(new Event('change'));
  expect(onRender).toHaveBeenLastCalledWith({ reflections: 'walls' });
});

describe('boombox column', () => {
  const boombox = (progress = vi.fn(() => ({ current: 0, duration: 0 }))) => ({
    title: 'song.mp3',
    volume: 1,
    progress,
    onVolume: vi.fn(),
    onSeek: vi.fn(),
    onStop: vi.fn(),
  });

  test('sits to the right of the renderer settings, empty until filled', () => {
    showAudioPanel(root, options());
    const children = [...(root.querySelector('.audio-panel') as HTMLElement).children].map((c) => c.className);
    expect(children).toEqual(['renderer', 'boombox-slot']);
    expect(root.querySelector('.boombox-slot')?.children).toHaveLength(0);
  });

  test('setAudioPanelBoombox fills and clears the column', () => {
    showAudioPanel(root, options());
    setAudioPanelBoombox(root, boombox());
    expect(root.querySelector('.boombox-slot .boombox-panel')?.textContent).toContain('song.mp3');
    setAudioPanelBoombox(root, null);
    expect(root.querySelector('.boombox-panel')).toBeNull();
  });

  test('with the panel closed, setAudioPanelBoombox does nothing', () => {
    setAudioPanelBoombox(root, boombox());
    expect(root.children).toHaveLength(0);
  });

  test('closing the panel stops the boombox column updating', () => {
    vi.useFakeTimers();
    try {
      showAudioPanel(root, options());
      const progress = vi.fn(() => ({ current: 0, duration: 0 }));
      setAudioPanelBoombox(root, boombox(progress));
      showAudioPanel(root, null);
      progress.mockClear();
      vi.advanceTimersByTime(PROGRESS_MS * 3);
      expect(progress).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
