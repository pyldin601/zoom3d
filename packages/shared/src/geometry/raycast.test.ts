import { describe, expect, test } from 'vitest';
import { LEVEL1 } from '../map/level1';
import { parseMap } from '../map/map';
import { castRay, createRayHit } from './raycast';

const ROOM = parseMap('11111\n1...1\n1.S.1\n1...1\n11111');

describe('castRay', () => {
  test('east from the room centre hits the x-side of column 4', () => {
    const hit = castRay(ROOM, 2.5, 2.5, 1, 0, createRayHit());
    expect(hit.distance).toBeCloseTo(1.5);
    expect(hit.mapX).toBe(4);
    expect(hit.side).toBe(0);
    expect(hit.wallX).toBeCloseTo(0.5);
    expect(hit.tile).toBe(1);
  });

  test('north hits the y-side of row 0', () => {
    const hit = castRay(ROOM, 2.5, 2.5, 0, -1, createRayHit());
    expect(hit.distance).toBeCloseTo(1.5);
    expect(hit.mapY).toBe(0);
    expect(hit.side).toBe(1);
  });

  test('integer start position on a tile edge stays finite', () => {
    const hit = castRay(ROOM, 2, 2, 1, 0, createRayHit());
    expect(hit.distance).toBeCloseTo(2);
  });

  test('diagonal ray is finite and never NaN', () => {
    const hit = castRay(ROOM, 2.5, 2.5, Math.SQRT1_2, Math.SQRT1_2, createRayHit());
    expect(Number.isNaN(hit.distance)).toBe(false);
    expect(hit.distance).toBeGreaterThan(1.4 * Math.SQRT1_2);
    expect(hit.distance).toBeLessThan(2.2);
    expect(Number.isNaN(hit.wallX)).toBe(false);
  });

  test('out of bounds counts as wall', () => {
    const hit = castRay(parseMap('S..'), 0.5, 0.5, -1, 0, createRayHit());
    expect(hit.distance).toBeCloseTo(0.5);
    expect(hit.tile).toBe(1);
  });

  test('writes into and returns the given out object', () => {
    const out = createRayHit();
    expect(castRay(ROOM, 2.5, 2.5, 1, 0, out)).toBe(out);
  });

  test('gives up after maxSteps with an infinite distance', () => {
    const hit = castRay(ROOM, 2.5, 2.5, 1, 0, createRayHit(), 1);
    expect(hit.distance).toBe(Number.POSITIVE_INFINITY);
    expect(hit.tile).toBe(0);
  });

  test('golden rays on LEVEL1 from the spawn centre', () => {
    const level = parseMap(LEVEL1);
    const east = castRay(level, 29.5, 50.5, 1, 0, createRayHit());
    expect(east.distance).toBeCloseTo(11.5);
    expect(east.tile).toBe(3);
    const north = castRay(level, 29.5, 50.5, 0, -1, createRayHit());
    expect(north.distance).toBeCloseTo(1.5);
    expect(north.mapY).toBe(48);
  });
});
