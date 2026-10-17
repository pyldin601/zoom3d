import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { bakeLighting, lampLight, type SurfacePoint } from './bake';
import { createLightmaps, FLOOR_CELLS, WALL_COLUMNS, WALL_HEIGHTS, wallSampleHeight } from './lightmaps';
import { buildTracedWorld, FACE_WEST, LAMP_RADIANCE, LAMP_RADIUS, type TracedWorld } from './world';

const NO_TEXTURES: Uint32Array[] = [];

/** A 9 x 9 room, walled all round. */
const OPEN_ROOM = `
11111111111
1S........1
1.........1
1.........1
1.........1
1.........1
1.........1
1.........1
1.........1
1.........1
11111111111`;
/** The same room with a one-tile pillar at (7, 5). */
const PILLAR_ROOM = `
11111111111
1S........1
1.........1
1.........1
1.........1
1......1..1
1.........1
1.........1
1.........1
1.........1
11111111111`;
/** Two rooms, 4 and 5 tiles wide, joined by a one-tile doorway at (5, 4). */
const DOORWAY_ROOMS = `
111111111111
1S...1.....1
1....1.....1
1....1.....1
1..........1
1....1.....1
1....1.....1
1....1.....1
111111111111`;
/** The doorway rooms with the partition taken out: the same lamp, nothing in its way. */
const NO_PARTITION_ROOMS = `
111111111111
1S.........1
1..........1
1..........1
1..........1
1..........1
1..........1
1..........1
111111111111`;
/** A 3 x 14 corridor: 12 tiles of floor in the middle row. */
const LONG_CORRIDOR = `
11111111111111
1S...........1
11111111111111`;

const CENTRE_LAMP = [{ x: 5.5, y: 5.5 }];

function worldOf(text: string, lamps: readonly { x: number; y: number }[]): TracedWorld {
  return buildTracedWorld(parseMap(text), NO_TEXTURES, lamps);
}

function lightAt(world: TracedWorld, at: SurfacePoint): Float32Array {
  const out = new Float32Array(3);
  lampLight(world, at, out);
  return out;
}

function floorPoint(x: number, y: number): SurfacePoint {
  return { x, y, z: 0, nx: 0, ny: 0, nz: 1 };
}

function floorLightAt(world: TracedWorld, x: number, y: number): number {
  return lightAt(world, floorPoint(x, y)).at(0) ?? Number.NaN;
}

describe('lampLight', () => {
  const room = worldOf(OPEN_ROOM, CENTRE_LAMP);

  test('on the floor right under the lamp is radiance x r^2, tinted warm', () => {
    const [red = 0, green = 0, blue = 0] = lightAt(room, floorPoint(5.5, 5.5));
    const underLamp = LAMP_RADIANCE * LAMP_RADIUS ** 2;
    expect(underLamp).toBeCloseTo(1.1664, 4);
    expect(red).toBeGreaterThan(underLamp * 0.99);
    expect(red).toBeLessThan(underLamp * 1.01);
    expect(green).toBeCloseTo(red * 0.84 ** 2.2, 4);
    expect(blue).toBeCloseTo(red * 0.6 ** 2.2, 4);
  });

  test('3 tiles along the floor it is radiance x r^2 x cos(surface) x cos(lamp) / d^2, faded towards the reach', () => {
    const distanceSquared = 3 ** 2 + 1 ** 2;
    const bothCosines = 1 / distanceSquared;
    const fade = (1 - (3 / 8) ** 4) ** 2;
    const expected = (LAMP_RADIANCE * LAMP_RADIUS ** 2 * bothCosines * fade) / distanceSquared;
    expect(floorLightAt(room, 8.5, 5.5)).toBeCloseTo(expected, 6);
  });

  test('is less the further the floor point, and never negative', () => {
    const lights = [0, 1, 2, 3, 4].map((tiles) => floorLightAt(room, 5.5 + tiles, 5.5));
    expect(lights.every((light) => light > 0)).toBe(true);
    for (let at = 1; at < lights.length; at++) {
      expect(lights.at(at)).toBeLessThan(lights.at(at - 1) ?? 0);
    }
  });

  test('a ceiling point gets none: the disc faces down', () => {
    const ceilingPoint = { x: 6.5, y: 5.5, z: 1, nx: 0, ny: 0, nz: -1 };
    expect(Array.from(lightAt(room, ceilingPoint))).toEqual([0, 0, 0]);
  });

  test('a wall point at the ceiling gets none: the disc is edge-on there', () => {
    const nearCeiling = { x: 9.999, y: 5.5, z: 1, nx: -1, ny: 0, nz: 0 };
    expect(Array.from(lightAt(room, nearCeiling))).toEqual([0, 0, 0]);
  });

  test('a wall point facing the lamp is lit, and one facing away is not', () => {
    const facing = { x: 9.999, y: 5.5, z: 0.5, nx: -1, ny: 0, nz: 0 };
    const away = { ...facing, nx: 1 };
    expect(lightAt(room, facing).at(0)).toBeGreaterThan(0);
    expect(Array.from(lightAt(room, away))).toEqual([0, 0, 0]);
  });

  test('along a corridor the lamp does not reach 8.5 tiles', () => {
    const corridor = worldOf(LONG_CORRIDOR, [{ x: 1.5, y: 1.5 }]);
    expect(floorLightAt(corridor, 1.5 + 7, 1.5)).toBeGreaterThan(0);
    expect(floorLightAt(corridor, 1.5 + 8.5, 1.5)).toBe(0);
  });

  test('behind a wall pillar from the lamp is dark', () => {
    const pillared = worldOf(PILLAR_ROOM, CENTRE_LAMP);
    expect(floorLightAt(room, 8.5, 5.5)).toBeGreaterThan(0);
    expect(floorLightAt(pillared, 8.5, 5.5)).toBe(0);
    expect(floorLightAt(pillared, 3.5, 5.5)).toBeGreaterThan(0);
  });

  test('sums the lamps: two lamps either side of a point give twice one lamp', () => {
    const one = worldOf(OPEN_ROOM, [{ x: 3.5, y: 5.5 }]);
    const two = worldOf(OPEN_ROOM, [
      { x: 3.5, y: 5.5 },
      { x: 7.5, y: 5.5 },
    ]);
    expect(floorLightAt(two, 5.5, 5.5)).toBeCloseTo(2 * floorLightAt(one, 5.5, 5.5), 6);
  });

  describe('across a doorway', () => {
    const lamp = [{ x: 2.5, y: 4.5 }];
    const doorway = worldOf(DOORWAY_ROOMS, lamp);
    const unobstructed = worldOf(NO_PARTITION_ROOMS, lamp);
    /** Floor points in the far room, from the middle of the lit patch into the shadow. */
    const sweep = Array.from({ length: 76 }, (_, step) => ({ x: 8.5, y: 4.5 - 0.02 * step }));
    const shadowed = sweep.map(({ x, y }) => floorLightAt(doorway, x, y));
    const open = sweep.map(({ x, y }) => floorLightAt(unobstructed, x, y));

    test('the lit patch ends in shadow', () => {
      expect(shadowed.at(0)).toBeCloseTo(open.at(0) ?? Number.NaN, 6);
      expect(shadowed.at(-1)).toBe(0);
    });

    test('light never increases going into the shadow', () => {
      for (let step = 1; step < shadowed.length; step++) {
        expect(shadowed.at(step)).toBeLessThanOrEqual((shadowed.at(step - 1) ?? 0) + 1e-9);
      }
    });

    test('the edge is soft: some points get part of what an open room would give', () => {
      const partlyLit = shadowed.filter((light, step) => light > 0 && light < 0.99 * (open.at(step) ?? 0));
      expect(partlyLit.length).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('bakeLighting', () => {
  const world = worldOf(OPEN_ROOM, CENTRE_LAMP);
  const maps = createLightmaps(world);
  const fractions = [...bakeLighting(world, maps)];

  test('yields fractions that increase and end at 1', () => {
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions.at(0)).toBeGreaterThan(0);
    expect(fractions.at(-1)).toBe(1);
    for (let at = 1; at < fractions.length; at++) {
      expect(fractions.at(at)).toBeGreaterThan(fractions.at(at - 1) ?? 0);
    }
  });

  test('the floor cell under the lamp holds the lamp light at that cell centre', () => {
    const cellsAcross = world.width * FLOOR_CELLS;
    const cellX = 5 * FLOOR_CELLS + 3;
    const cellY = 5 * FLOOR_CELLS + 3;
    const centre = floorPoint((cellX + 0.5) / FLOOR_CELLS, (cellY + 0.5) / FLOOR_CELLS);
    const baked = maps.floor.subarray((cellY * cellsAcross + cellX) * 3, (cellY * cellsAcross + cellX) * 3 + 3);
    expect(baked.at(0)).toBeGreaterThan(1);
    expect(Array.from(baked)).toEqual(Array.from(lightAt(world, centre)));
  });

  test('the ceiling and the floor cells of wall tiles get none', () => {
    expect(maps.ceiling.every((value) => value === 0)).toBe(true);
    const topWallRow = maps.floor.subarray(0, world.width * FLOOR_CELLS * 3);
    expect(topWallRow.every((value) => value === 0)).toBe(true);
  });

  test('a wall sample holds the lamp light 1e-3 in front of its face; the one at the ceiling holds none', () => {
    const eastWall = { tileX: 10, tileY: 5 };
    const faceIndex = world.faceIndex[(eastWall.tileY * world.width + eastWall.tileX) * 4 + FACE_WEST] ?? -1;
    expect(faceIndex).toBeGreaterThanOrEqual(0);
    const column = 3;
    const wallSample = (row: number) => {
      const at = ((faceIndex * WALL_HEIGHTS + row) * WALL_COLUMNS + column) * 3;
      return Array.from(maps.wall.subarray(at, at + 3));
    };
    const lampAt = (row: number) =>
      Array.from(
        lightAt(world, {
          x: eastWall.tileX - 1e-3,
          y: eastWall.tileY + (column + 0.5) / WALL_COLUMNS,
          z: wallSampleHeight(row),
          nx: -1,
          ny: 0,
          nz: 0,
        })
      );
    for (const row of [0, 1]) {
      expect(wallSample(row).at(0)).toBeGreaterThan(0);
      expect(wallSample(row)).toEqual(lampAt(row));
    }
    expect(wallSample(2)).toEqual([0, 0, 0]);
  });
});
