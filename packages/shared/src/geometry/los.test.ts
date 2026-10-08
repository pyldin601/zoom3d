import { expect, test } from 'vitest';
import { LEVEL1 } from '../map/level1';
import { parseMap } from '../map/map';
import { hasLineOfSight } from './los';

const PILLAR = parseMap('1111111\n1.....1\n1..1..1\n1S....1\n1111111');

test('open row is clear', () => {
  expect(hasLineOfSight(PILLAR, 1.5, 1.5, 5.5, 1.5)).toBe(true);
});

test('a pillar in between blocks', () => {
  expect(hasLineOfSight(PILLAR, 1.5, 2.5, 5.5, 2.5)).toBe(false);
});

test('co-located points are clear', () => {
  expect(hasLineOfSight(PILLAR, 2.5, 2.5, 2.5, 2.5)).toBe(true);
});

test('a diagonal through the pillar cell is blocked; one beside it is clear', () => {
  expect(hasLineOfSight(PILLAR, 1.5, 3.5, 5.5, 1.5)).toBe(false);
  expect(hasLineOfSight(PILLAR, 1.5, 1.5, 2.5, 3.5)).toBe(true);
});

test("the endpoints' own cells are ignored", () => {
  expect(hasLineOfSight(PILLAR, 3.5, 2.5, 5.5, 2.5)).toBe(true);
  expect(hasLineOfSight(PILLAR, 1.5, 2.5, 3.5, 2.5)).toBe(true);
});

test('symmetric', () => {
  expect(hasLineOfSight(PILLAR, 5.5, 2.5, 1.5, 2.5)).toBe(false);
  expect(hasLineOfSight(PILLAR, 5.5, 1.5, 1.5, 3.5)).toBe(false);
});

test('LEVEL1: the wall at row 48 separates the spawn room from the room above', () => {
  const level = parseMap(LEVEL1);
  expect(hasLineOfSight(level, 29.5, 50.5, 29.5, 44.5)).toBe(false);
  expect(hasLineOfSight(level, 29.5, 50.5, 33.5, 50.5)).toBe(true);
});
