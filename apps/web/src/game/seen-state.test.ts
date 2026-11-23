import { expect, test } from 'vitest';
import { createStateRing } from './seen-state';

const numbers = () =>
  createStateRing<{ v: number }>(
    4,
    () => ({ v: 0 }),
    (from, to) => {
      to.v = from.v;
    },
    (a, b) => a.v === b.v
  );

test('a value that repeats is kept once', () => {
  const ring = numbers();
  ring.push(0, { v: 1 });
  ring.push(10, { v: 1 });
  ring.push(20, { v: 2 });
  expect(ring.at(15)).toEqual({ v: 1 });
  expect(ring.at(20)).toEqual({ v: 2 });
});

test('at gives the newest at or before the time, and the oldest before all', () => {
  const ring = numbers();
  ring.push(100, { v: 1 });
  ring.push(200, { v: 2 });
  ring.push(300, { v: 3 });
  expect(ring.at(250)).toEqual({ v: 2 });
  expect(ring.at(1000)).toEqual({ v: 3 });
  expect(ring.at(50)).toEqual({ v: 1 });
});

test('past its capacity the oldest go first', () => {
  const ring = numbers();
  for (let i = 1; i <= 6; i++) {
    ring.push(i * 10, { v: i });
  }
  expect(ring.at(0)).toEqual({ v: 3 });
  expect(ring.at(60)).toEqual({ v: 6 });
});

test('cleared, it holds nothing until the next push', () => {
  const ring = numbers();
  ring.push(10, { v: 1 });
  ring.clear();
  expect(ring.empty).toBe(true);
  ring.push(20, { v: 2 });
  expect(ring.at(0)).toEqual({ v: 2 });
});
