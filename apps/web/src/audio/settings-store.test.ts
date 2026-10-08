import { DEFAULT_AUDIO_SETTINGS } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { AUDIO_SETTINGS_KEY, loadAudioSettings, saveAudioSettings } from './settings-store';

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

test('round-trips through storage', () => {
  const store = memory();
  const custom = { ...DEFAULT_AUDIO_SETTINGS, max: 20, panning: 'equalpower' as const };
  saveAudioSettings(store, custom);
  expect(loadAudioSettings(store)).toEqual(custom);
  expect(store.data.has(AUDIO_SETTINGS_KEY)).toBe(true);
});

test('broken or missing storage gives the defaults', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  expect(loadAudioSettings(throwing)).toEqual(DEFAULT_AUDIO_SETTINGS);
  expect(() => saveAudioSettings(throwing, DEFAULT_AUDIO_SETTINGS)).not.toThrow();
  expect(loadAudioSettings(null)).toEqual(DEFAULT_AUDIO_SETTINGS);
  expect(() => saveAudioSettings(null, DEFAULT_AUDIO_SETTINGS)).not.toThrow();
});

test('stale or invalid stored values are normalised', () => {
  const store = memory();
  store.data.set(AUDIO_SETTINGS_KEY, '{"max":"far","reverb":0.5}');
  expect(loadAudioSettings(store)).toEqual({ ...DEFAULT_AUDIO_SETTINGS, reverb: 0.5 });
  store.data.set(AUDIO_SETTINGS_KEY, 'not json');
  expect(loadAudioSettings(store)).toEqual(DEFAULT_AUDIO_SETTINGS);
});
