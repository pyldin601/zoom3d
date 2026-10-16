import { expect, test } from 'vitest';
import {
  DEFAULT_RENDER_SETTINGS,
  litReflections,
  loadRenderSettings,
  RENDER_MODES,
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

test('the renderer defaults to shadows and reflections', () => {
  expect(DEFAULT_RENDER_SETTINGS).toEqual({ mode: 'reflections' });
});

test('every mode is kept as it was saved', () => {
  const store = memory();
  for (const mode of RENDER_MODES) {
    saveRenderSettings(store, { mode });
    expect(loadRenderSettings(store)).toEqual({ mode });
  }
  expect(RENDER_MODES).toEqual(['flat', 'shadows', 'reflections', 'reflections-only']);
});

test('each mode picks what the lit renderer reflects; flat is drawn unlit', () => {
  expect(RENDER_MODES.map(litReflections)).toEqual([null, 'none', 'both', 'only']);
});

test('round-trips through storage', () => {
  const store = memory();
  saveRenderSettings(store, { mode: 'shadows' });
  expect(loadRenderSettings(store)).toEqual({ mode: 'shadows' });
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
  store.data.set(RENDER_SETTINGS_KEY, '{"mode":"ceiling"}');
  expect(loadRenderSettings(store)).toEqual(DEFAULT_RENDER_SETTINGS);
  // Saved before the modes, as a reflections choice.
  store.data.set(RENDER_SETTINGS_KEY, '{"reflections":"none"}');
  expect(loadRenderSettings(store)).toEqual(DEFAULT_RENDER_SETTINGS);
});

test('settings saved with an option that no longer exists keep the rest', () => {
  const store = memory();
  // Saved while there was an ambient light switch.
  store.data.set(RENDER_SETTINGS_KEY, '{"mode":"flat","ambient":false}');
  expect(loadRenderSettings(store)).toEqual({ mode: 'flat' });
});
