// @vitest-environment happy-dom
import { DEFAULT_AUDIO_SETTINGS } from '@zoom3d/shared';
import { beforeEach, expect, test, vi } from 'vitest';
import { showAudioPanel } from './audio-panel';

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
