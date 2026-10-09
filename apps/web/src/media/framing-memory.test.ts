import { expect, test, vi } from 'vitest';
import { createFramingMemory, FRAMING_KEY } from './framing-memory';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: vi.fn((k: string) => data[k] ?? null),
    setItem: vi.fn((k: string, v: string) => {
      data[k] = v;
    }),
  };
}

const rect = { x: 232, y: 144.4, size: 176 };

test('a saved rect comes back for the same camera and frame size only', () => {
  const s = fakeStorage();
  createFramingMemory(s).save('cam1', 640, 480, rect);
  expect(createFramingMemory(s).load('cam1', 640, 480)).toEqual(rect);
  expect(createFramingMemory(s).load('cam1', 1280, 720)).toBeNull();
  expect(createFramingMemory(s).load('cam2', 640, 480)).toBeNull();
});

test('each camera keeps its own rect', () => {
  const s = fakeStorage();
  const other = { x: 100, y: 50, size: 300 };
  createFramingMemory(s).save('cam1', 640, 480, rect);
  createFramingMemory(s).save('cam2', 640, 480, other);
  expect(createFramingMemory(s).load('cam1', 640, 480)).toEqual(rect);
  expect(createFramingMemory(s).load('cam2', 640, 480)).toEqual(other);
});

test('an unchanged rect is not written again', () => {
  const s = fakeStorage();
  const m = createFramingMemory(s);
  m.save('cam1', 640, 480, rect);
  m.save('cam1', 640, 480, { ...rect });
  expect(s.setItem).toHaveBeenCalledTimes(1);
  m.save('cam1', 640, 480, { ...rect, x: 200 });
  expect(s.setItem).toHaveBeenCalledTimes(2);
});

test.each([
  ['not json', '{'],
  ['not a map', JSON.stringify([{ w: 640, h: 480, x: 0, y: 0, size: 176 }])],
  ['wrong shape', JSON.stringify({ cam1: { w: 640, h: 480, x: 'a', y: 0, size: 176 } })],
  ['not finite', '{"cam1":{"w":640,"h":480,"x":0,"y":0,"size":1e999}}'],
])('%s is ignored', (_, raw) => {
  expect(createFramingMemory(fakeStorage({ [FRAMING_KEY]: raw })).load('cam1', 640, 480)).toBeNull();
});

test('missing or throwing storage is harmless', () => {
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  expect(createFramingMemory(null).load('cam1', 640, 480)).toBeNull();
  expect(createFramingMemory(broken).load('cam1', 640, 480)).toBeNull();
  expect(() => createFramingMemory(broken).save('cam1', 640, 480, rect)).not.toThrow();
});
