import { expect, test } from 'vitest';
import {
  DEFAULT_LIGHT_SPEED,
  DEFAULT_RENDER_SETTINGS,
  LIGHT_LOOK_NAMES,
  LIGHT_LOOKS,
  LIGHT_SPEED_MAX,
  LIGHT_SPEED_MIN,
  litReflections,
  loadRenderSettings,
  nextRenderMode,
  normalizeRenderSettings,
  PORTAL_LOOK_NAMES,
  PORTAL_LOOKS,
  RENDER_MODES,
  RENDER_SETTINGS_KEY,
  saveRenderSettings,
} from './render-settings';

const LIGHT = { light: 'instant', lightSpeed: 12 } as const;

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

test('the renderer defaults to shadows and reflections', () => {
  expect(DEFAULT_RENDER_SETTINGS).toEqual({ mode: 'reflections', portals: 'classic', ...LIGHT });
});

test('every mode is kept as it was saved', () => {
  const store = memory();
  for (const mode of RENDER_MODES) {
    saveRenderSettings(store, { mode, portals: 'classic', ...LIGHT });
    expect(loadRenderSettings(store)).toEqual({ mode, portals: 'classic', ...LIGHT });
  }
  expect(RENDER_MODES).toEqual(['flat', 'shadows', 'reflections', 'reflections-only']);
});

test('each mode picks what the lit renderer reflects; flat is drawn unlit', () => {
  expect(RENDER_MODES.map(litReflections)).toEqual([null, 'none', 'both', 'only']);
});

test('a saved mode that is gone, as the ray-traced one is, loads as the default', () => {
  const store = memory();
  store.setItem(RENDER_SETTINGS_KEY, JSON.stringify({ mode: 'traced' }));
  expect(loadRenderSettings(store)).toEqual(DEFAULT_RENDER_SETTINGS);
});

test('the next mode follows the console order and wraps around', () => {
  expect(nextRenderMode('flat')).toBe('shadows');
  expect(nextRenderMode('reflections-only')).toBe('flat');
});

test('round-trips through storage', () => {
  const store = memory();
  saveRenderSettings(store, { mode: 'shadows', portals: 'realistic', ...LIGHT });
  expect(loadRenderSettings(store)).toEqual({ mode: 'shadows', portals: 'realistic', ...LIGHT });
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
  expect(loadRenderSettings(store)).toEqual({ mode: 'flat', portals: 'classic', ...LIGHT });
});

test('settings saved before the portal look load as classic, keeping their mode', () => {
  expect(normalizeRenderSettings({ mode: 'shadows' })).toEqual({ mode: 'shadows', portals: 'classic', ...LIGHT });
});

test('each setting is checked on its own', () => {
  expect(normalizeRenderSettings({ mode: 'flat', portals: 'realistic', ...LIGHT })).toEqual({
    mode: 'flat',
    portals: 'realistic',
    ...LIGHT,
  });
  expect(normalizeRenderSettings({ portals: 'weird' })).toEqual({ mode: 'reflections', portals: 'classic', ...LIGHT });
});

test('the portal looks, in the console order, with their names', () => {
  expect(PORTAL_LOOKS.map((look) => PORTAL_LOOK_NAMES[look])).toEqual(['Classic', 'Realistic']);
});

test('light defaults to instant at 12 tiles/s', () => {
  const s = normalizeRenderSettings(null);
  expect(s.light).toBe('instant');
  expect(s.lightSpeed).toBe(12);
  expect(DEFAULT_LIGHT_SPEED).toBe(12);
  expect([LIGHT_SPEED_MIN, LIGHT_SPEED_MAX]).toEqual([6, 60]);
});

test('keeps a stored slow look and its speed', () => {
  expect(normalizeRenderSettings({ light: 'slow', lightSpeed: 20 })).toMatchObject({ light: 'slow', lightSpeed: 20 });
});

test('a bad light or speed falls back alone', () => {
  expect(normalizeRenderSettings({ mode: 'shadows', light: 'warp', lightSpeed: 'fast' })).toEqual({
    mode: 'shadows',
    portals: 'classic',
    light: 'instant',
    lightSpeed: 12,
  });
});

test("the speed is rounded and clamped into the slider's range", () => {
  const speed = (lightSpeed: unknown) => normalizeRenderSettings({ lightSpeed }).lightSpeed;
  expect([speed(2), speed(500), speed(12.6), speed(Number.NaN)]).toEqual([6, 60, 13, 12]);
});

test('the light looks, in the console order, with their names', () => {
  expect(LIGHT_LOOKS.map((look) => LIGHT_LOOK_NAMES[look])).toEqual(['Instant', 'Slow']);
});
