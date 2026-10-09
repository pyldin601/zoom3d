// @vitest-environment happy-dom
import { DEFAULT_AUDIO_SETTINGS } from '@zoom3d/shared';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { setAudioPanelBoombox, showAudioPanel } from './audio-panel';
import { PROGRESS_MS } from './boombox-panel';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.getElementById('ui') as HTMLElement;
});

const input = (label: string) => {
  const row = [...root.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label));
  return row?.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
};

test('moving a slider reports normalised settings and shows the value', () => {
  const onChange = vi.fn();
  showAudioPanel(root, { settings: DEFAULT_AUDIO_SETTINGS, onChange });
  const max = input('Silent beyond') as HTMLInputElement;
  max.value = '20';
  max.dispatchEvent(new Event('input'));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_AUDIO_SETTINGS, max: 20 });
  expect(root.textContent).toContain('20');
});

test('the output select switches panning', () => {
  const onChange = vi.fn();
  showAudioPanel(root, { settings: DEFAULT_AUDIO_SETTINGS, onChange });
  const select = input('Output') as HTMLSelectElement;
  select.value = 'equalpower';
  select.dispatchEvent(new Event('change'));
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_AUDIO_SETTINGS, panning: 'equalpower' });
});

test('reset restores the defaults', () => {
  const onChange = vi.fn();
  showAudioPanel(root, { settings: { ...DEFAULT_AUDIO_SETTINGS, reverb: 0.2 }, onChange });
  (root.querySelector('button') as HTMLButtonElement).click();
  expect(onChange).toHaveBeenLastCalledWith(DEFAULT_AUDIO_SETTINGS);
  expect((input('Reverb') as HTMLInputElement).value).toBe('1');
});

test('null removes the panel', () => {
  showAudioPanel(root, { settings: DEFAULT_AUDIO_SETTINGS, onChange: () => {} });
  expect(root.querySelector('.audio-panel')).not.toBeNull();
  showAudioPanel(root, null);
  expect(root.querySelector('.audio-panel')).toBeNull();
});

test('speaking levels are listed by name as text', () => {
  showAudioPanel(root, {
    settings: DEFAULT_AUDIO_SETTINGS,
    onChange: () => {},
    levels: () => [{ name: '<b>Bob</b>', speaking: 0.5 }],
  });
  expect(root.querySelector('b')).toBeNull();
  expect(root.textContent).toContain('<b>Bob</b>');
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

  test('sits to the right of the tuning settings, empty until filled', () => {
    showAudioPanel(root, { settings: DEFAULT_AUDIO_SETTINGS, onChange: vi.fn() });
    const children = [...(root.querySelector('.audio-panel') as HTMLElement).children].map((c) => c.className);
    expect(children).toEqual(['tuning', 'boombox-slot']);
    expect(root.querySelector('.tuning')?.textContent).toContain('Silent beyond');
    expect(root.querySelector('.boombox-slot')?.children).toHaveLength(0);
  });

  test('setAudioPanelBoombox fills and clears the column', () => {
    showAudioPanel(root, { settings: DEFAULT_AUDIO_SETTINGS, onChange: vi.fn() });
    setAudioPanelBoombox(root, boombox());
    expect(root.querySelector('.boombox-slot .boombox-panel')?.textContent).toContain('song.mp3');
    setAudioPanelBoombox(root, null);
    expect(root.querySelector('.boombox-panel')).toBeNull();
  });

  test('with the audio panel closed, setAudioPanelBoombox does nothing', () => {
    setAudioPanelBoombox(root, boombox());
    expect(root.children).toHaveLength(0);
  });

  test('closing the audio panel stops the boombox column updating', () => {
    vi.useFakeTimers();
    try {
      showAudioPanel(root, { settings: DEFAULT_AUDIO_SETTINGS, onChange: vi.fn() });
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
