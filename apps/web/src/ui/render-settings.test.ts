import { expect, test } from 'vitest';
import {
  DEFAULT_RENDER_SETTINGS,
  loadRenderSettings,
  RENDER_SETTINGS_KEY,
  saveRenderSettings,
} from './render-settings';

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

test('reflections default to walls and floor, with ambient light on', () => {
  expect(DEFAULT_RENDER_SETTINGS).toEqual({ reflections: 'both', ambient: true });
});

test('round-trips through storage', () => {
  const store = memory();
  saveRenderSettings(store, { reflections: 'walls', ambient: false });
  expect(loadRenderSettings(store)).toEqual({ reflections: 'walls', ambient: false });
  expect(store.data.has(RENDER_SETTINGS_KEY)).toBe(true);
});

test('broken, missing or stale storage gives the defaults', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  expect(loadRenderSettings(throwing)).toEqual(DEFAULT_RENDER_SETTINGS);
  expect(() => saveRenderSettings(throwing, DEFAULT_RENDER_SETTINGS)).not.toThrow();
  expect(loadRenderSettings(null)).toEqual(DEFAULT_RENDER_SETTINGS);
  const store = memory();
  store.data.set(RENDER_SETTINGS_KEY, '{"reflections":"ceiling"}');
  expect(loadRenderSettings(store)).toEqual(DEFAULT_RENDER_SETTINGS);
});

test('each stored setting is checked on its own: a bad or missing one falls back alone', () => {
  const store = memory();
  // Saved before the ambient switch existed.
  store.data.set(RENDER_SETTINGS_KEY, '{"reflections":"walls"}');
  expect(loadRenderSettings(store)).toEqual({ reflections: 'walls', ambient: true });
  store.data.set(RENDER_SETTINGS_KEY, '{"reflections":"ceiling","ambient":false}');
  expect(loadRenderSettings(store)).toEqual({ reflections: 'both', ambient: false });
  store.data.set(RENDER_SETTINGS_KEY, '{"reflections":"none","ambient":"dim"}');
  expect(loadRenderSettings(store)).toEqual({ reflections: 'none', ambient: true });
});
