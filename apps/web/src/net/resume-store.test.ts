import { expect, test } from 'vitest';
import { RESUME_KEY, saveResume, takeResume } from './resume-store';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_ROOM = 'BBBBBBBBBBBBBBBBBBBBBB';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test('a saved token is taken back once, for its own room', () => {
  const storage = memoryStorage();
  saveResume(storage, ROOM, 'tok');
  expect(RESUME_KEY).toBe('zoom3d.resume');
  expect(takeResume(storage, ROOM)).toBe('tok');
  expect(takeResume(storage, ROOM)).toBeNull();
});

test('a token saved in another room is not used, and is dropped', () => {
  const storage = memoryStorage();
  saveResume(storage, OTHER_ROOM, 'tok');
  expect(takeResume(storage, ROOM)).toBeNull();
  expect(storage.map.has(RESUME_KEY)).toBe(false);
});

test('a malformed entry reads as nothing', () => {
  const storage = memoryStorage();
  for (const junk of ['not json', '{}', '{"roomId":"AAAAAAAAAAAAAAAAAAAAAA","token":7}', 'null']) {
    storage.setItem(RESUME_KEY, junk);
    expect(takeResume(storage, ROOM)).toBeNull();
  }
});

test('throwing or missing storage is tolerated', () => {
  const boom = () => {
    throw new Error('blocked');
  };
  expect(takeResume({ getItem: boom, removeItem: boom }, ROOM)).toBeNull();
  expect(() => saveResume({ setItem: boom }, ROOM, 'tok')).not.toThrow();
  expect(takeResume(null, ROOM)).toBeNull();
  expect(() => saveResume(null, ROOM, 'tok')).not.toThrow();
});
