import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import {
  createLightmaps,
  FLOOR_CELLS,
  planeLight,
  type TracedLightmaps,
  WALL_COLUMNS,
  WALL_HEIGHTS,
  wallColumnLight,
  wallSampleHeight,
} from './lightmaps';
import { buildTracedWorld, NO_FACE } from './world';

const NO_TEXTURES: Uint32Array[] = [];
/** Open floor at x 1..4 of the middle row, walled all round: 4 + 4 + 2 = 10 faces have floor in front of them. */
const CORRIDOR = buildTracedWorld(parseMap('111111\n1S...1\n111111'), NO_TEXTURES, []);
const CELLS_PER_CORRIDOR_ROW = CORRIDOR.width * FLOOR_CELLS;

function setCell(lm: Float32Array, cellX: number, cellY: number, rgb: readonly number[]): void {
  lm.set(rgb, (cellY * CELLS_PER_CORRIDOR_ROW + cellX) * 3);
}

function lightOf(lm: Float32Array, x: number, y: number): number[] {
  const out = new Float32Array(3);
  planeLight(lm, CORRIDOR, x, y, out);
  return Array.from(out);
}

describe('the layout', () => {
  test('floor and ceiling have 8 samples per tile side; walls 8 across and 3 up, at 0, 0.5 and 1', () => {
    expect([FLOOR_CELLS, WALL_COLUMNS, WALL_HEIGHTS]).toEqual([8, 8, 3]);
    expect([0, 1, 2].map(wallSampleHeight)).toEqual([0, 0.5, 1]);
  });
});

describe('createLightmaps', () => {
  const maps = createLightmaps(CORRIDOR);

  test('floor, ceiling, their soft copies and the floor bounce hold 8 x 8 rgb samples per tile', () => {
    const floats = CORRIDOR.width * CORRIDOR.height * FLOOR_CELLS * FLOOR_CELLS * 3;
    for (const lm of [maps.floor, maps.ceiling, maps.floorSoft, maps.ceilingSoft, maps.floorBounce]) {
      expect(lm.length).toBe(floats);
    }
  });

  test('walls hold 3 rows of 8 rgb samples per visible face', () => {
    expect(CORRIDOR.faceCount).toBe(10);
    expect(maps.wall.length).toBe(CORRIDOR.faceCount * WALL_HEIGHTS * WALL_COLUMNS * 3);
  });

  test('start dark: pure rays, no base light', () => {
    for (const lm of [maps.floor, maps.ceiling, maps.wall, maps.floorSoft, maps.ceilingSoft, maps.floorBounce]) {
      expect(lm.every((value) => value === 0)).toBe(true);
    }
  });
});

describe('planeLight', () => {
  const lm = new Float32Array(CORRIDOR.width * CORRIDOR.height * FLOOR_CELLS * FLOOR_CELLS * 3);
  setCell(lm, 10, 12, [1, 2, 3]);
  setCell(lm, 11, 12, [3, 6, 9]);
  setCell(lm, 10, 13, [5, 10, 15]);
  const rowCentre = (12 + 0.5) / FLOOR_CELLS;

  test('at a cell centre is that cell', () => {
    expect(lightOf(lm, 10.5 / FLOOR_CELLS, rowCentre)).toEqual([1, 2, 3]);
  });

  test('between two cells is their average', () => {
    expect(lightOf(lm, 11 / FLOOR_CELLS, rowCentre)).toEqual([2, 4, 6]);
  });

  test('between two rows is their average', () => {
    expect(lightOf(lm, 10.5 / FLOOR_CELLS, 13 / FLOOR_CELLS)).toEqual([3, 6, 9]);
  });

  test('a quarter of the way across blends a quarter of the next cell', () => {
    expect(lightOf(lm, 10.75 / FLOOR_CELLS, rowCentre)).toEqual([1.5, 3, 4.5]);
  });

  test('off the map takes the edge sample', () => {
    const edge = new Float32Array(lm.length);
    setCell(edge, 0, 0, [4, 5, 6]);
    expect(lightOf(edge, -3, -3)).toEqual([4, 5, 6]);
    setCell(edge, CELLS_PER_CORRIDOR_ROW - 1, CORRIDOR.height * FLOOR_CELLS - 1, [7, 8, 9]);
    expect(lightOf(edge, CORRIDOR.width + 3, CORRIDOR.height + 3)).toEqual([7, 8, 9]);
  });
});

describe('wallColumnLight', () => {
  const face = 3;
  const maps: TracedLightmaps = createLightmaps(CORRIDOR);
  for (let row = 0; row < WALL_HEIGHTS; row++) {
    for (let column = 0; column < WALL_COLUMNS; column++) {
      const at = ((face * WALL_HEIGHTS + row) * WALL_COLUMNS + column) * 3;
      maps.wall.set([row + 1, column, 10 * row + column], at);
    }
  }

  function lightAcross(faceIndex: number, u: number): number[] {
    const out = new Float32Array(WALL_HEIGHTS * 3).fill(9);
    wallColumnLight(maps, faceIndex, u, out);
    return Array.from(out);
  }

  test('at u = 0.5 blends columns 3 and 4, at each of the 3 heights', () => {
    expect(lightAcross(face, 0.5)).toEqual([1, 3.5, 3.5, 2, 3.5, 13.5, 3, 3.5, 23.5]);
  });

  test('at a column centre is that column', () => {
    expect(lightAcross(face, 5.5 / WALL_COLUMNS)).toEqual([1, 5, 5, 2, 5, 15, 3, 5, 25]);
  });

  test('past the first and last column centres takes the edge column', () => {
    expect(lightAcross(face, 0)).toEqual([1, 0, 0, 2, 0, 10, 3, 0, 20]);
    expect(lightAcross(face, 1)).toEqual([1, 7, 7, 2, 7, 17, 3, 7, 27]);
  });

  test('a face index of NO_FACE gives zeros', () => {
    expect(lightAcross(NO_FACE, 0.5)).toEqual(new Array(9).fill(0));
  });
});
