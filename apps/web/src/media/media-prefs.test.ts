import { expect, test } from 'vitest';
import { DEFAULT_MEDIA_PREFS, loadMediaPrefs, MEDIA_KEY, saveMediaPrefs } from './media-prefs';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

test('defaults match the spec', () => {
  expect(MEDIA_KEY).toBe('zoom3d.media');
  expect(DEFAULT_MEDIA_PREFS).toEqual({ cam: true, mic: true, camId: null, micId: null });
});

test('round-trips saved prefs', () => {
  const storage = memoryStorage();
  const prefs = { cam: false, mic: true, camId: 'c1', micId: null };
  saveMediaPrefs(storage, prefs);
  expect(loadMediaPrefs(storage)).toEqual(prefs);
});

test('missing, malformed or wrongly typed JSON gives the defaults', () => {
  for (const raw of [
    null,
    '{',
    '[]',
    'null',
    '{"cam":"yes","mic":true,"camId":null,"micId":null}',
    '{"cam":true,"mic":true,"camId":5,"micId":null}',
    '{"cam":true,"mic":true,"camId":null}',
  ]) {
    expect(loadMediaPrefs({ getItem: () => raw })).toEqual(DEFAULT_MEDIA_PREFS);
  }
  expect(loadMediaPrefs(null)).toEqual(DEFAULT_MEDIA_PREFS);
});

test('storage that throws is ignored', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  expect(loadMediaPrefs(throwing)).toEqual(DEFAULT_MEDIA_PREFS);
  expect(() => saveMediaPrefs(throwing, DEFAULT_MEDIA_PREFS)).not.toThrow();
});
