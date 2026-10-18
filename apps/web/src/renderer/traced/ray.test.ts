import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import {
  clearBetween,
  createRay3,
  createRayHit3,
  HIT_CEILING,
  HIT_FLOOR,
  HIT_NONE,
  HIT_WALL,
  type Ray3,
  trace,
} from './ray';
import { buildTracedWorld, FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_WEST } from './world';

const NO_LAMPS: { x: number; y: number }[] = [];
const NO_TEXTURES: Uint32Array[] = [];

/** Open floor at x 1..4 of the middle row, walled all round: a 6 x 3 corridor. */
const CORRIDOR = buildTracedWorld(parseMap('111111\n1S...1\n111111'), NO_TEXTURES, NO_LAMPS);
/** Open floor at y 1..4 of the middle column, walled all round: the same corridor turned 90 degrees. */
const TALL_CORRIDOR = buildTracedWorld(parseMap('111\n1S1\n1.1\n1.1\n1.1\n111'), NO_TEXTURES, NO_LAMPS);
/** A wood wall (tile 2) at the east end, a blue one (tile 3) at the west end. */
const COLOURED_ENDS = buildTracedWorld(parseMap('333333\n3S...2\n333333'), NO_TEXTURES, NO_LAMPS);

function rayFrom(x: number, y: number, z: number, dx: number, dy: number, dz: number): Ray3 {
  return { x, y, z, dx, dy, dz };
}

function traceFrom(world: typeof CORRIDOR, ray: Ray3, maxT = 100) {
  return trace(world, ray, maxT, createRayHit3());
}

describe('trace', () => {
  test('east along the corridor, it hits the end wall through its west face', () => {
    const hit = traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 1, 0, 0));
    expect(hit.kind).toBe(HIT_WALL);
    expect(hit.t).toBeCloseTo(3.5);
    expect(hit.side).toBe(FACE_WEST);
    expect(hit.faceIndex).toBeGreaterThanOrEqual(0);
    expect(hit.u).toBeCloseTo(0.5);
    expect([hit.x, hit.y, hit.z]).toEqual([5, 1.5, 0.5]);
    expect(hit.tile).toBe(1);
  });

  test('each direction enters the wall through the face looking back at the ray', () => {
    const west = traceFrom(CORRIDOR, rayFrom(3.5, 1.5, 0.5, -1, 0, 0));
    expect([west.kind, west.side, west.t]).toEqual([HIT_WALL, FACE_EAST, 2.5]);
    const north = traceFrom(TALL_CORRIDOR, rayFrom(1.5, 3.5, 0.5, 0, -1, 0));
    expect([north.kind, north.side, north.t]).toEqual([HIT_WALL, FACE_SOUTH, 2.5]);
    const south = traceFrom(TALL_CORRIDOR, rayFrom(1.5, 3.5, 0.5, 0, 1, 0));
    expect([south.kind, south.side, south.t]).toEqual([HIT_WALL, FACE_NORTH, 1.5]);
  });

  test('u runs along y on west and east faces and along x on north and south faces', () => {
    const onEastFace = traceFrom(TALL_CORRIDOR, rayFrom(1.5, 2.2, 0.5, -1, 0.5, 0));
    expect(onEastFace.side).toBe(FACE_EAST);
    expect(onEastFace.u).toBeCloseTo(0.45);
    const onNorthFace = traceFrom(CORRIDOR, rayFrom(1.25, 1.5, 0.5, 0.25, 1, 0));
    expect(onNorthFace.side).toBe(FACE_NORTH);
    expect(onNorthFace.u).toBeCloseTo(0.375);
  });

  test('the hit names the wall cell’s tile', () => {
    expect(traceFrom(COLOURED_ENDS, rayFrom(2.5, 1.5, 0.5, 1, 0, 0)).tile).toBe(2);
    expect(traceFrom(COLOURED_ENDS, rayFrom(2.5, 1.5, 0.5, -1, 0, 0)).tile).toBe(3);
  });

  test('a ray at an angle is blocked where its path across the grid enters the wall', () => {
    const hit = traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 1, 0.25, 0));
    expect(hit.kind).toBe(HIT_WALL);
    expect(hit.side).toBe(FACE_NORTH);
    expect(hit.t).toBeCloseTo(2);
    expect(hit.y).toBeCloseTo(2);
  });

  test('straight down it hits the floor, straight up the ceiling', () => {
    const down = traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 0, 0, -1));
    expect(down.kind).toBe(HIT_FLOOR);
    expect(down.z).toBe(0);
    expect(down.t).toBeCloseTo(0.5);
    expect([down.x, down.y]).toEqual([1.5, 1.5]);
    const up = traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 0, 0, 1));
    expect(up.kind).toBe(HIT_CEILING);
    expect(up.z).toBe(1);
    expect(up.t).toBeCloseTo(0.5);
  });

  test('rising at slope 1 toward a wall 3 tiles away, it reaches the ceiling first', () => {
    const hit = traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 1, 0, 1));
    expect(hit.kind).toBe(HIT_CEILING);
    expect(hit.t).toBeCloseTo(0.5);
    expect(hit.x).toBeCloseTo(2);
  });

  test('falling shallowly, it reaches the wall before the floor', () => {
    const hit = traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 1, 0, -0.1));
    expect(hit.kind).toBe(HIT_WALL);
    expect(hit.z).toBeCloseTo(0.5 - 0.1 * 3.5);
  });

  test('rays along an axis give a finite t, never NaN', () => {
    const alongX = traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 1, 0, 0));
    const alongY = traceFrom(TALL_CORRIDOR, rayFrom(1.5, 1.5, 0.5, 0, 1, 0));
    for (const hit of [alongX, alongY]) {
      expect(hit.kind).toBe(HIT_WALL);
      expect(Number.isFinite(hit.t)).toBe(true);
      expect(Number.isFinite(hit.x) && Number.isFinite(hit.y) && Number.isFinite(hit.z)).toBe(true);
    }
  });

  test('an axis-aligned ray that starts on a cell boundary still gives a finite t', () => {
    const hit = traceFrom(CORRIDOR, rayFrom(2, 1, 0.5, 1, 0, 0));
    expect(hit.kind).toBe(HIT_WALL);
    expect(hit.t).toBeCloseTo(3);
  });

  test('a ray with no direction hits nothing', () => {
    expect(traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 0, 0, 0)).kind).toBe(HIT_NONE);
  });

  test('a maxT short of the wall hits nothing, and one past it still hits', () => {
    expect(traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 1, 0, 0), 3).kind).toBe(HIT_NONE);
    expect(traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 1, 0, 0), 4).kind).toBe(HIT_WALL);
  });

  test('a maxT short of the floor hits nothing', () => {
    expect(traceFrom(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 0, 0, -1), 0.4).kind).toBe(HIT_NONE);
  });

  test('it fills and returns the hit it is given', () => {
    const out = createRayHit3();
    expect(trace(CORRIDOR, rayFrom(1.5, 1.5, 0.5, 1, 0, 0), 100, out)).toBe(out);
  });

  test('createRay3 and createRayHit3 start empty', () => {
    expect(createRay3()).toEqual({ x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 });
    expect(createRayHit3().kind).toBe(HIT_NONE);
  });
});

describe('clearBetween', () => {
  const ROOM_WITH_PILLAR = buildTracedWorld(
    parseMap('1111111\n1S....1\n1..1..1\n1.....1\n1111111'),
    NO_TEXTURES,
    NO_LAMPS
  );

  test('across open floor it is true', () => {
    expect(clearBetween(ROOM_WITH_PILLAR, 1.5, 1.5, 5.5, 1.5)).toBe(true);
    expect(clearBetween(ROOM_WITH_PILLAR, 1.5, 3.5, 5.5, 3.5)).toBe(true);
  });

  test('across a wall cell it is false, whichever way round', () => {
    expect(clearBetween(ROOM_WITH_PILLAR, 1.5, 2.5, 5.5, 2.5)).toBe(false);
    expect(clearBetween(ROOM_WITH_PILLAR, 5.5, 2.5, 1.5, 2.5)).toBe(false);
  });

  test('a point is clear of itself, and an end exactly on a wall face is clear', () => {
    expect(clearBetween(ROOM_WITH_PILLAR, 2.5, 1.5, 2.5, 1.5)).toBe(true);
    expect(clearBetween(ROOM_WITH_PILLAR, 2.5, 1.5, 6, 1.5)).toBe(true);
    expect(clearBetween(ROOM_WITH_PILLAR, 2.5, 1.5, 6.5, 1.5)).toBe(false);
  });

  test('leaving the map is blocked', () => {
    expect(clearBetween(ROOM_WITH_PILLAR, 1.5, 1.5, -3, 1.5)).toBe(false);
  });
});
