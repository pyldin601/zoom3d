import { expect, test } from 'vitest';
import { parseMap } from '../map/map';
import { isPlausibleMove } from './movecheck';

const ROOM = parseMap('11111\n1...1\n1.S.1\n1...1\n11111');

test('a normal step is plausible', () => {
  expect(isPlausibleMove(ROOM, { x: 2.5, y: 2.5 }, { x: 2.8, y: 2.5 }, 100)).toBe(true);
});

test('a teleport is not', () => {
  expect(isPlausibleMove(ROOM, { x: 1.5, y: 1.5 }, { x: 3.5, y: 3.5 }, 100)).toBe(false);
});

test('a wall target is never plausible', () => {
  expect(isPlausibleMove(ROOM, { x: 2.5, y: 2.5 }, { x: 4.5, y: 2.5 }, 100_000)).toBe(false);
});

test('half a tile of slack even with no elapsed time', () => {
  expect(isPlausibleMove(ROOM, { x: 2.5, y: 2.5 }, { x: 3.0, y: 2.5 }, 0)).toBe(true);
});
