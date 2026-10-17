import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { makeTextures } from '../textures';
import { bakeLighting, lampLight, makeSoftCopy, type SurfacePoint } from './bake';
import {
  createLightmaps,
  FLOOR_CELLS,
  planeCellOffset,
  type TracedLightmaps,
  WALL_COLUMNS,
  WALL_HEIGHTS,
  wallSampleHeight,
} from './lightmaps';
import { buildTracedWorld, FACE_WEST, LAMP_RADIANCE, LAMP_RADIUS, type TracedWorld } from './world';

const TEXTURES = makeTextures(1);
const MAP_NAMES = [
  'floor',
  'ceiling',
  'wall',
  'floorSoft',
  'ceilingSoft',
  'floorBounce',
] as const satisfies readonly (keyof TracedLightmaps)[];

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
  return buildTracedWorld(parseMap(text), TEXTURES, lamps);
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

  /** The floor or ceiling cell (cellX, cellY) of a plane map, as rgb. */
  function cellOf(plane: Float32Array, cellX: number, cellY: number): number[] {
    const at = planeCellOffset(world, cellX, cellY);
    return Array.from(plane.subarray(at, at + 3));
  }

  /** The floor point at the middle of cell (cellX, cellY). */
  function cellCentre(cellX: number, cellY: number): SurfacePoint {
    return floorPoint((cellX + 0.5) / FLOOR_CELLS, (cellY + 0.5) / FLOOR_CELLS);
  }

  test('yields fractions that start at 0 once the samples are listed, increase and end at 1', () => {
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions.at(0)).toBe(0);
    expect(fractions.at(-1)).toBe(1);
    for (let at = 1; at < fractions.length; at++) {
      expect(fractions.at(at)).toBeGreaterThan(fractions.at(at - 1) ?? 0);
    }
  });

  test('the bar is weighted by cost: the direct pass, a small part of the work, moves it under 10%', () => {
    const fresh = createLightmaps(world);
    let fractionWhileCeilingDark = Number.NaN;
    for (const fraction of bakeLighting(world, fresh)) {
      if (fresh.ceiling.every((value) => value === 0)) {
        fractionWhileCeilingDark = fraction;
      }
    }
    expect(fractionWhileCeilingDark).toBeGreaterThan(0);
    expect(fractionWhileCeilingDark).toBeLessThan(0.1);
  });

  test('the floor cell under the lamp holds the lamp light at its centre plus under half as much bounce', () => {
    const [cellX, cellY] = [5 * FLOOR_CELLS + 3, 5 * FLOOR_CELLS + 3];
    const direct = Array.from(lightAt(world, cellCentre(cellX, cellY)));
    expect(direct.at(0)).toBeGreaterThan(1);
    const baked = cellOf(maps.floor, cellX, cellY);
    for (const [channel, light] of direct.entries()) {
      expect(baked.at(channel)).toBeGreaterThanOrEqual(light);
      expect(baked.at(channel)).toBeLessThanOrEqual(1.5 * light);
    }
  });

  test('the ceiling gets no direct light, and the bounce off the lit floor lights it', () => {
    const [cellX, cellY] = [5 * FLOOR_CELLS + 3, 5 * FLOOR_CELLS + 3];
    const aboveFloorCell = { ...cellCentre(cellX, cellY), z: 1, nz: -1 };
    expect(Array.from(lightAt(world, aboveFloorCell))).toEqual([0, 0, 0]);
    expect(cellOf(maps.ceiling, cellX, cellY).every((light) => light > 0)).toBe(true);
  });

  test('the floor bounce map holds the bounce alone: the floor is the lamp light plus it', () => {
    for (const [cellX, cellY] of [
      [5 * FLOOR_CELLS + 3, 5 * FLOOR_CELLS + 3],
      [3 * FLOOR_CELLS + 1, 4 * FLOOR_CELLS + 6],
      [8 * FLOOR_CELLS + 5, 2 * FLOOR_CELLS + 2],
    ] as const) {
      const direct = lightAt(world, cellCentre(cellX, cellY));
      const bounce = cellOf(maps.floorBounce, cellX, cellY);
      expect(bounce.every((light) => light > 0)).toBe(true);
      for (const [channel, light] of cellOf(maps.floor, cellX, cellY).entries()) {
        expect(light).toBeCloseTo((direct.at(channel) ?? 0) + (bounce.at(channel) ?? 0), 4);
      }
    }
  });

  test('smooths the noise of 16 rays: bounce light in the middle of the room varies little from cell to cell', () => {
    /** Mean, over the cells of tiles 3 to 7, of how far a cell's red is from its four neighbours' mean, as a share. */
    function cellToCellNoise(plane: Float32Array): number {
      const red = (cellX: number, cellY: number) => plane.at(planeCellOffset(world, cellX, cellY)) ?? Number.NaN;
      const first = 3 * FLOOR_CELLS;
      const last = 8 * FLOOR_CELLS;
      let total = 0;
      for (let cellY = first; cellY < last; cellY++) {
        for (let cellX = first; cellX < last; cellX++) {
          const around =
            (red(cellX - 1, cellY) + red(cellX + 1, cellY) + red(cellX, cellY - 1) + red(cellX, cellY + 1)) / 4;
          total += Math.abs(red(cellX, cellY) - around) / red(cellX, cellY);
        }
      }
      return total / (last - first) ** 2;
    }
    // Measured: 0.02 and 0.04 smoothed, 0.16 and 0.31 without the 3 x 3 mean.
    expect(cellToCellNoise(maps.floorBounce)).toBeLessThan(0.08);
    expect(cellToCellNoise(maps.ceiling)).toBeLessThan(0.08);
  });

  test('a floor cell inside a wall tile holds the mean of its open neighbours, so no black pulls in at the edges', () => {
    // The first cell of the wall tile (10, 5), against the open tile (9, 5): three open neighbours to its west.
    const [cellX, cellY] = [10 * FLOOR_CELLS, 5 * FLOOR_CELLS + 3];
    const openNeighbours = [-1, 0, 1].map((rowShift) => cellOf(maps.floor, cellX - 1, cellY + rowShift));
    const mean = [0, 1, 2].map((channel) => {
      const sum = openNeighbours.reduce((total, light) => total + (light.at(channel) ?? 0), 0);
      return sum / openNeighbours.length;
    });
    expect(mean.every((light) => light > 0)).toBe(true);
    for (const [channel, light] of cellOf(maps.floor, cellX, cellY).entries()) {
      expect(light).toBeCloseTo(mean.at(channel) ?? Number.NaN, 5);
    }
  });

  test('a wall sample holds at least the lamp light 1e-3 in front of its face, and the ceiling row holds bounce', () => {
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
      for (const [channel, light] of lampAt(row).entries()) {
        expect(light).toBeGreaterThan(0);
        expect(wallSample(row).at(channel)).toBeGreaterThan(light);
      }
    }
    expect(lampAt(2)).toEqual([0, 0, 0]);
    expect(wallSample(2).every((light) => light > 0)).toBe(true);
  });

  test('the soft maps are the soft copies of the finished floor and ceiling, and not dark', () => {
    for (const [sharp, soft] of [
      [maps.floor, maps.floorSoft],
      [maps.ceiling, maps.ceilingSoft],
    ] as const) {
      const expected = new Float32Array(sharp.length);
      makeSoftCopy(world, sharp, expected);
      expect(soft).toEqual(expected);
      expect(soft.some((light) => light > 0)).toBe(true);
    }
  });

  test('two bakes of the same world are identical', () => {
    const again = createLightmaps(world);
    for (const _ of bakeLighting(world, again)) {
      // Run to the end.
    }
    for (const name of MAP_NAMES) {
      expect(again[name], name).toEqual(maps[name]);
    }
  });

  test('a room without lamps stays black: no base light, no bounce from nothing', () => {
    const dark = worldOf(OPEN_ROOM, []);
    const darkMaps = createLightmaps(dark);
    for (const _ of bakeLighting(dark, darkMaps)) {
      // Run to the end.
    }
    for (const name of MAP_NAMES) {
      expect(
        darkMaps[name].every((light) => light === 0),
        name
      ).toBe(true);
    }
  });
});

describe('bounce light takes the colour of the walls it bounces off', () => {
  /** The OPEN_ROOM with every wall tile `tile`, lit by a lamp 2.5 tiles from the east wall; the floor by that wall. */
  function floorBesideEastWall(tile: number): number[] {
    const room = worldOf(OPEN_ROOM.replaceAll('1', String(tile)), [{ x: 7.5, y: 5.5 }]);
    const roomMaps = createLightmaps(room);
    for (const _ of bakeLighting(room, roomMaps)) {
      // Run to the end.
    }
    const at = planeCellOffset(room, 9 * FLOOR_CELLS + 7, 3 * FLOOR_CELLS + 6);
    return Array.from(roomMaps.floor.subarray(at, at + 3));
  }

  test('a floor cell by a lit blue-brick wall is bluer than by a lit stone wall', () => {
    const [stoneRed = 0, , stoneBlue = 0] = floorBesideEastWall(1);
    const [blueRed = 0, , blueBlue = 0] = floorBesideEastWall(3);
    expect(stoneBlue / stoneRed).toBeGreaterThan(0);
    expect(blueBlue / blueRed).toBeGreaterThan((stoneBlue / stoneRed) * 1.1);
  });
});

describe('makeSoftCopy', () => {
  const world = worldOf(OPEN_ROOM, CENTRE_LAMP);
  const cellsAcross = world.width * FLOOR_CELLS;
  const cellsDown = world.height * FLOOR_CELLS;
  const brightCell = { cellX: 44, cellY: 44 };
  const sharp = new Float32Array(cellsAcross * cellsDown * 3);
  sharp.fill(1, planeCellOffset(world, brightCell.cellX, brightCell.cellY), planeCellOffset(world, 45, 44));
  const soft = new Float32Array(sharp.length);
  makeSoftCopy(world, sharp, soft);

  test('spreads one bright cell smoothly: it never rises going outwards along its row, for 8 cells', () => {
    const redAlongRow = Array.from({ length: 9 }, (_, step) => soft.at(planeCellOffset(world, 44 + step, 44)) ?? 0);
    expect(redAlongRow.at(0)).toBeGreaterThan(redAlongRow.at(4) ?? Number.POSITIVE_INFINITY);
    expect(redAlongRow.at(4)).toBeGreaterThan(0);
    for (let step = 1; step < redAlongRow.length; step++) {
      expect(redAlongRow.at(step)).toBeLessThanOrEqual((redAlongRow.at(step - 1) ?? 0) + 1e-7);
    }
  });

  test('keeps the light: the soft map adds up to within 5% of the sharp one', () => {
    const total = (map: Float32Array) => map.reduce((sum, light) => sum + light, 0);
    expect(total(soft)).toBeGreaterThan(total(sharp) * 0.95);
    expect(total(soft)).toBeLessThan(total(sharp) * 1.05);
  });

  test('averages over 4 cells each way, twice: nothing beyond 8 cells, something at 8', () => {
    expect(soft.at(planeCellOffset(world, 44 + 8, 44))).toBeGreaterThan(0);
    expect(soft.at(planeCellOffset(world, 44 + 9, 44))).toBe(0);
  });
});
