import { expect, test } from 'vitest';
import { BOOMBOX_VOLUME_KEY, loadBoomboxVolume, saveBoomboxVolume } from './boombox-store';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

test('round-trips a volume', () => {
  expect(BOOMBOX_VOLUME_KEY).toBe('zoom3d.boombox.volume');
  const s = memoryStorage();
  saveBoomboxVolume(s, 0.35);
  expect(s.map.get(BOOMBOX_VOLUME_KEY)).toBe('0.35');
  expect(loadBoomboxVolume(s)).toBe(0.35);
  saveBoomboxVolume(s, 0);
  expect(loadBoomboxVolume(s)).toBe(0);
});

test('nothing saved means full volume', () => {
  expect(loadBoomboxVolume(memoryStorage())).toBe(1);
});

test('junk loads as full volume, and out-of-range values are clamped', () => {
  for (const junk of ['loud', '', 'NaN', 'Infinity']) {
    expect(loadBoomboxVolume({ getItem: () => junk })).toBe(1);
  }
  expect(loadBoomboxVolume({ getItem: () => '7' })).toBe(1);
  expect(loadBoomboxVolume({ getItem: () => '-2' })).toBe(0);
  const s = memoryStorage();
  saveBoomboxVolume(s, 3);
  expect(s.map.get(BOOMBOX_VOLUME_KEY)).toBe('1');
});

test('throwing or missing storage is tolerated', () => {
  const boom = () => {
    throw new Error('blocked');
  };
  expect(loadBoomboxVolume({ getItem: boom })).toBe(1);
  expect(() => saveBoomboxVolume({ setItem: boom }, 0.5)).not.toThrow();
  expect(loadBoomboxVolume(null)).toBe(1);
  expect(() => saveBoomboxVolume(null, 0.5)).not.toThrow();
});
