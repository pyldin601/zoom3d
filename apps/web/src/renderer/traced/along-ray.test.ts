import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { makeTextures } from '../textures';
import {
  type ConeAcrossMap,
  createNearbyThings,
  createThingsAlongRay,
  findThingsAlongRay,
  listNearbyThings,
  MOST_ALONG_RAY,
  type NearbyThings,
} from './along-ray';
import { buildTracedWorld, LAMP_RADIUS } from './world';

/** A hall 40 tiles long and 5 wide, walled all round. */
const HALL = parseMap(
  [
    '1'.repeat(42),
    ...Array.from({ length: 5 }, (_, row) => `1${row === 2 ? 'S' : '.'}${'.'.repeat(39)}1`),
    '1'.repeat(42),
  ].join('\n')
);
const TEXTURES = makeTextures(1);

/** Lamps' discs at these points, as a frame lists them. */
function lampsAt(points: readonly { x: number; y: number }[]): NearbyThings {
  return {
    count: points.length,
    x: Float64Array.from(points, (point) => point.x),
    y: Float64Array.from(points, (point) => point.y),
    radius: new Float64Array(points.length).fill(LAMP_RADIUS),
  };
}

describe('listNearbyThings', () => {
  test('lists the lamps within 12 tiles of the eye, and only them', () => {
    const lamps = [3, 10, 14.5, 16, 30].map((x) => ({ x, y: 3.5 }));
    const world = buildTracedWorld(HALL, TEXTURES, lamps);
    const nearby = createNearbyThings();
    listNearbyThings(world, 3, 3.5, nearby);
    expect(Array.from(nearby.x.subarray(0, nearby.count))).toEqual([3, 10, 14.5]);
    expect(Array.from(nearby.radius.subarray(0, nearby.count))).toEqual([LAMP_RADIUS, LAMP_RADIUS, LAMP_RADIUS]);
  });

  test('is listed afresh each frame, from where the eye is now', () => {
    const world = buildTracedWorld(
      HALL,
      TEXTURES,
      [3, 30].map((x) => ({ x, y: 3.5 }))
    );
    const nearby = createNearbyThings();
    listNearbyThings(world, 3, 3.5, nearby);
    listNearbyThings(world, 25, 3.5, nearby);
    expect(Array.from(nearby.x.subarray(0, nearby.count))).toEqual([30]);
  });
});

describe('findThingsAlongRay', () => {
  const along = createThingsAlongRay();

  /** A ray from (2, 3.5) along +x, a unit a tile, stopping 100 along: a ray with no cone round it, unless told. */
  function east(cone: Partial<ConeAcrossMap> = {}): ConeAcrossMap {
    return { x: 2, y: 3.5, dx: 1, dy: 0, wallS: 100, spreadPerS: 0, ...cone };
  }

  test('finds a lamp ahead: how far along the ray, in its units, and how far to its side, in tiles', () => {
    findThingsAlongRay(lampsAt([{ x: 6, y: 3.6 }]), east({ dx: 2 }), along);
    expect(along.count).toBe(1);
    expect(along.s.at(0)).toBeCloseTo(2, 9);
    expect(Math.abs(along.side.at(0) ?? 0)).toBeCloseTo(0.1, 9);
    expect(along.thing.at(0)).toBe(0);
  });

  test("keeps a lamp within its radius of a ray's centre, and drops one just past it when the cone is a ray", () => {
    findThingsAlongRay(lampsAt([{ x: 6, y: 3.5 + LAMP_RADIUS * 0.9 }]), east(), along);
    expect(along.count).toBe(1);
    findThingsAlongRay(lampsAt([{ x: 6, y: 3.5 + LAMP_RADIUS * 1.1 }]), east(), along);
    expect(along.count).toBe(0);
  });

  test('reaches three spreads of the cone further to the side, at the distance the lamp is along the ray', () => {
    // A spread of 0.05 tiles per unit 4 units along is 0.2 tiles: three of them reach 0.6 tiles past the radius.
    const spreadPerS = 0.05;
    findThingsAlongRay(lampsAt([{ x: 6, y: 3.5 + LAMP_RADIUS + 0.58 }]), east({ spreadPerS }), along);
    expect(along.count).toBe(1);
    findThingsAlongRay(lampsAt([{ x: 6, y: 3.5 + LAMP_RADIUS + 0.62 }]), east({ spreadPerS }), along);
    expect(along.count).toBe(0);
  });

  test('never reaches more than 2 tiles past the radius, however wide the cone', () => {
    findThingsAlongRay(lampsAt([{ x: 22, y: 3.5 + LAMP_RADIUS + 1.9 }]), east({ spreadPerS: 1 }), along);
    expect(along.count).toBe(1);
    findThingsAlongRay(lampsAt([{ x: 22, y: 3.5 + LAMP_RADIUS + 2.1 }]), east({ spreadPerS: 1 }), along);
    expect(along.count).toBe(0);
  });

  test('drops lamps behind where the ray starts and from where it stops on', () => {
    const lamps = lampsAt([1, 2.01, 5, 9, 11].map((x) => ({ x, y: 3.5 })));
    findThingsAlongRay(lamps, east({ wallS: 9 }), along);
    expect(Array.from(along.s.subarray(0, along.count))).toEqual([3, 7]);
  });

  test(`keeps the nearest ${MOST_ALONG_RAY} along the ray, nearest first, whatever order they are listed in`, () => {
    const xs = [30, 4, 25, 9, 17, 6, 38, 12, 21, 5, 33, 15, 8, 27, 11, 19];
    findThingsAlongRay(lampsAt(xs.map((x) => ({ x, y: 3.5 }))), east(), along);
    const nearest = [...xs].sort((a, b) => a - b).slice(0, MOST_ALONG_RAY);
    expect(Array.from(along.s.subarray(0, along.count))).toEqual(nearest.map((x) => x - 2));
    expect(Array.from(along.thing.subarray(0, along.count))).toEqual(nearest.map((x) => xs.indexOf(x)));
  });
});
