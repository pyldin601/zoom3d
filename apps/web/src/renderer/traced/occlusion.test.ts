import { describe, expect, test } from 'vitest';
import type { NearbyThings } from './along-ray';
import {
  createLampsPastWalls,
  findLampsPastWalls,
  gaussianBelow,
  seeLampsFrom,
  softenWallDistances,
} from './occlusion';
import { LAMP_RADIUS } from './world';

/** 100 reflection columns, an eye at the origin looking down +y, 10 columns per tile across at a distance of 1 tile. */
const COLUMNS = 100;
const EYE = { x: 0, y: 0, dirX: 0, dirY: 1 };
const COLUMNS_PER_TILE = 10;
/** The cone's spread across (tiles): 2 tiles away, 0.5 tiles is 2.5 columns. */
const SPREAD_TILES = 0.5;

function lampsAt(points: readonly { x: number; y: number }[]): NearbyThings {
  return {
    count: points.length,
    x: Float64Array.from(points, (point) => point.x),
    y: Float64Array.from(points, (point) => point.y),
    radius: new Float64Array(points.length).fill(LAMP_RADIUS),
  };
}

/** Wall distances per column: `near` everywhere but `far` over columns [from, to). */
function wallsWithGap(near: number, far: number, from: number, to: number): Float64Array {
  return Float64Array.from({ length: COLUMNS }, (_, col) => (col >= from && col < to ? far : near));
}

/** How much of a lamp `depth` tiles ahead the cone from each column sees, past `walls`. */
function shownFromEveryColumn(walls: Float64Array, depth: number): number[] {
  const past = createLampsPastWalls();
  findLampsPastWalls(lampsAt([{ x: 0, y: depth }]), EYE, walls, COLUMNS_PER_TILE, SPREAD_TILES, past);
  return Array.from({ length: COLUMNS }, (_, col) => {
    seeLampsFrom(past, col);
    return past.shown.at(0) ?? Number.NaN;
  });
}

function biggestStep(values: readonly number[]): number {
  return Math.max(...values.slice(1).map((value, at) => Math.abs(value - (values.at(at) ?? 0))));
}

describe('gaussianBelow', () => {
  test("is a unit Gaussian's share below z deviations, 0 and 1 exactly past sqrt(18) of them", () => {
    expect(gaussianBelow(0)).toBeCloseTo(0.5, 6);
    expect(gaussianBelow(1)).toBeCloseTo(0.841345, 6);
    expect(gaussianBelow(-2)).toBeCloseTo(0.02275, 5);
    expect(gaussianBelow(4.3)).toBe(1);
    expect(gaussianBelow(-4.3)).toBe(0);
    expect(gaussianBelow(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('a lamp past the walls, seen across columns', () => {
  test('nearer than every wall, it is seen whole from every column', () => {
    expect(new Set(shownFromEveryColumn(wallsWithGap(10, 20, 40, 60), 5))).toEqual(new Set([1]));
  });

  test('past every wall, it is not seen at all', () => {
    expect(new Set(shownFromEveryColumn(wallsWithGap(4, 4.5, 40, 60), 5))).toEqual(new Set([0]));
  });

  test("through a gap it shows from the gap's middle, half at its edges, and fades smoothly to nothing beside it", () => {
    // 4 tiles away the cone spreads 0.5 tiles: 1.25 columns.
    const shown = shownFromEveryColumn(wallsWithGap(3, 20, 40, 60), 4);
    expect(shown.at(50)).toBeCloseTo(1, 6);
    expect(((shown.at(39) ?? 0) + (shown.at(40) ?? 0)) / 2).toBeCloseTo(0.5, 1);
    expect(shown.at(30)).toBe(0);
    expect(shown.at(70)).toBe(0);
    // The steepest a Gaussian's share changes per column is 1 / (deviation sqrt(2 pi)): 0.32 here.
    expect(biggestStep(shown)).toBeLessThan(0.33);
  });

  test('a nearer lamp spreads over more columns, so it fades over more of them', () => {
    const near = shownFromEveryColumn(wallsWithGap(1, 20, 40, 60), 1.5);
    const far = shownFromEveryColumn(wallsWithGap(3, 20, 40, 60), 4);
    expect(biggestStep(near)).toBeLessThan(biggestStep(far) / 2);
    expect(near.at(35)).toBeGreaterThan(0);
  });

  test("columns off the screen don't count: a gap at its edge shows the lamp whole from there", () => {
    const shown = shownFromEveryColumn(wallsWithGap(3, 20, 0, 30), 4);
    expect(shown.at(0)).toBeCloseTo(1, 6);
    expect(shown.at(50)).toBe(0);
  });
});

describe('softenWallDistances', () => {
  test('leaves walls all at one distance as they are, and none in reach as none', () => {
    for (const distance of [0.3, 2, 7.5]) {
      const soft = new Float64Array(COLUMNS);
      softenWallDistances(new Float64Array(COLUMNS).fill(distance), COLUMNS_PER_TILE, SPREAD_TILES, soft);
      for (const blended of soft) {
        expect(blended).toBeCloseTo(distance, 12);
      }
    }
    const soft = new Float64Array(COLUMNS);
    softenWallDistances(new Float64Array(COLUMNS).fill(Number.POSITIVE_INFINITY), COLUMNS_PER_TILE, SPREAD_TILES, soft);
    expect(new Set(soft)).toEqual(new Set([Number.POSITIVE_INFINITY]));
  });

  test('blends a jump in depth over the columns the cone spreads across, so no column steps far from the next', () => {
    // At 1 tile the cone spreads 5 columns, at 4 tiles 1.25.
    const walls = wallsWithGap(1, 4, 50, COLUMNS);
    const soft = new Float64Array(COLUMNS);
    softenWallDistances(walls, COLUMNS_PER_TILE, SPREAD_TILES, soft);
    expect(soft.at(20)).toBe(1);
    expect(soft.at(80)).toBe(4);
    for (let col = 1; col < COLUMNS; col++) {
      expect(soft.at(col), `column ${col}`).toBeGreaterThanOrEqual(soft.at(col - 1) ?? 0);
    }
    expect(soft.at(49)).toBeGreaterThan(1.1);
    expect(soft.at(50)).toBeLessThan(3.5);
    // Blended as nearness (1 / distance), which a wall out of reach (0) blends into too: the jump is 0.75 of it.
    const nearness = Array.from(soft, (distance) => 1 / distance);
    expect(biggestStep(nearness)).toBeLessThan(0.75 / 2);
  });

  test('a wall out of reach blends into its neighbours as no nearness at all', () => {
    const soft = new Float64Array(COLUMNS);
    softenWallDistances(wallsWithGap(2, Number.POSITIVE_INFINITY, 50, COLUMNS), COLUMNS_PER_TILE, SPREAD_TILES, soft);
    expect(soft.at(49)).toBeGreaterThan(2);
    expect(Number.isFinite(soft.at(49))).toBe(true);
    expect(soft.at(80)).toBe(Number.POSITIVE_INFINITY);
  });
});
