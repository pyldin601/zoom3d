import { expect, test } from 'vitest';
import { loadName, NAME_KEY, saveName } from './name-store';

test('round-trips the name under zoom3d.name', () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  expect(loadName(storage)).toBe('');
  saveName(storage, 'Ada');
  expect(NAME_KEY).toBe('zoom3d.name');
  expect(map.get(NAME_KEY)).toBe('Ada');
  expect(loadName(storage)).toBe('Ada');
});

test('throwing or missing storage is tolerated', () => {
  const boom = () => {
    throw new Error('blocked');
  };
  expect(loadName({ getItem: boom })).toBe('');
  expect(() => saveName({ setItem: boom }, 'Ada')).not.toThrow();
  expect(loadName(null)).toBe('');
  expect(() => saveName(null, 'Ada')).not.toThrow();
});
