import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { type Glow, glowLight } from './glow';
import {
  createHeadlightGlows,
  HEADLIGHT_AHEAD_TILES,
  HEADLIGHT_COLOUR,
  HEADLIGHT_CONE_HALF_RAD,
  HEADLIGHT_FRINGE_RAD,
  HEADLIGHT_REACH,
  HEADLIGHT_STRENGTH,
} from './headlight';
import { FLOOR_SUB } from './lighting';
import { portalHall } from './test-portals';

// Scooter headlight spec: an open 12×5 room, and a copy with a pillar at (7, 2) that a refilled table would show.
const open = parseMap(`
111111111111
1S.........1
1..........1
1..........1
111111111111
`);
const pillar = parseMap(`
111111111111
1S.........1
1......1...1
1..........1
111111111111
`);
const EAST = 0;
const SOUTH = Math.PI / 2;
const rider = (x: number, y: number, angle = EAST, key = 'a') => ({ key, x, y, angle });

/** One rider's lamp: its red, green and blue glows, in that order. */
function only(glows: readonly Glow[]): Glow {
  const g = glows.at(1);
  if (!g || glows.length !== 3) {
    throw new Error(`expected one lamp of three glows, got ${glows.length} glows`);
  }
  return g;
}

function channels(glows: readonly Glow[]): [Glow, Glow, Glow] {
  const [red, green, blue] = glows;
  if (!red || !green || !blue || glows.length !== 3) {
    throw new Error(`expected one lamp of three glows, got ${glows.length} glows`);
  }
  return [red, green, blue];
}

/** The shadow table's value for the floor cell holding (x, y). */
function seenAt(g: Glow, x: number, y: number): number | undefined {
  const shadow = g.shadow;
  if (!shadow) {
    throw new Error('no shadow table');
  }
  const col = Math.floor(x * FLOOR_SUB) - shadow.firstCol;
  const row = Math.floor(y * FLOOR_SUB) - shadow.firstRow;
  return shadow.seen[row * shadow.across + col];
}

/** The light a floor point gets from `g`. */
const floorLight = (g: Glow, x: number, y: number) => glowLight(g, x, y, 0, 0, 0, 1);

describe('createHeadlightGlows', () => {
  test('the glow sits ahead of the rider along the heading, its cone pointing the same way', () => {
    const g = only(createHeadlightGlows().update([rider(5.5, 1.5, SOUTH)], open, null));
    expect(g.x).toBeCloseTo(5.5);
    expect(g.y).toBeCloseTo(1.5 + HEADLIGHT_AHEAD_TILES);
    expect(g.cone?.dx).toBeCloseTo(0);
    expect(g.cone?.dy).toBeCloseTo(1);
    expect(g.reach).toBe(HEADLIGHT_REACH);
  });

  test('a lamp is a red, a green and a blue glow that add up to the headlight colour', () => {
    const [red, green, blue] = channels(createHeadlightGlows().update([rider(5.5, 2.5)], open, null));
    expect([red.r, red.g, red.b]).toEqual([HEADLIGHT_COLOUR.r * HEADLIGHT_STRENGTH, 0, 0]);
    expect([green.r, green.g, green.b]).toEqual([0, HEADLIGHT_COLOUR.g * HEADLIGHT_STRENGTH, 0]);
    expect([blue.r, blue.g, blue.b]).toEqual([0, 0, HEADLIGHT_COLOUR.b * HEADLIGHT_STRENGTH]);
    // One shadow table for the three: walls block every colour the same.
    expect(red.shadow).toBe(green.shadow);
    expect(blue.shadow).toBe(green.shadow);
    expect([red.x, red.y]).toEqual([green.x, green.y]);
  });

  test('red reaches widest and blue narrowest: well inside all three light, at the edge only red does', () => {
    const [red, green, blue] = channels(createHeadlightGlows().update([rider(5.5, 2.5)], open, null));
    const lamp = 5.5 + HEADLIGHT_AHEAD_TILES;
    const atDeg = (deg: number) =>
      [lamp + 2 * Math.cos((deg * Math.PI) / 180), 2.5 + 2 * Math.sin((deg * Math.PI) / 180)] as const;
    const inside = atDeg(5);
    for (const g of [red, green, blue]) {
      expect(floorLight(g, ...inside)).toBeGreaterThan(0);
    }
    const edgeDeg = ((HEADLIGHT_CONE_HALF_RAD + HEADLIGHT_FRINGE_RAD / 2) * 180) / Math.PI;
    const edge = atDeg(edgeDeg);
    expect(floorLight(red, ...edge)).toBeGreaterThan(0);
    expect(floorLight(green, ...edge)).toBe(0);
    expect(floorLight(blue, ...edge)).toBe(0);
    const yellow = atDeg(((HEADLIGHT_CONE_HALF_RAD - HEADLIGHT_FRINGE_RAD / 2) * 180) / Math.PI);
    expect(floorLight(green, ...yellow)).toBeGreaterThan(0);
    expect(floorLight(blue, ...yellow)).toBe(0);
  });

  test('it lights the floor ahead and none behind', () => {
    const g = only(createHeadlightGlows().update([rider(5.5, 2.5)], open, null));
    expect(floorLight(g, 8, 2.5)).toBeGreaterThan(0);
    expect(floorLight(g, 3, 2.5)).toBe(0);
  });

  test('a wall blocks it', () => {
    const g = only(createHeadlightGlows().update([rider(4.5, 2.5)], pillar, null));
    expect(floorLight(g, 9.5, 2.5)).toBe(0);
    expect(floorLight(g, 6.5, 2.5)).toBeGreaterThan(0);
  });

  test('turning keeps the table and turns the cone; moving to another floor cell refills the table', () => {
    const lights = createHeadlightGlows();
    const first = only(lights.update([rider(4.5, 2.5)], open, null));
    expect(seenAt(first, 9.5, 2.5)).toBeGreaterThan(0);
    // The same lamp cell, on the pillar map: a refill would put the floor past the pillar in its shadow.
    const turned = only(lights.update([rider(4.5, 2.5, 0.01)], pillar, null));
    expect(seenAt(turned, 9.5, 2.5)).toBeGreaterThan(0);
    expect(turned.cone?.dy).toBeCloseTo(Math.sin(0.01));
    const moved = only(lights.update([rider(4.5 + 1 / FLOOR_SUB, 2.5)], pillar, null));
    expect(seenAt(moved, 9.5, 2.5)).toBe(0);
  });

  test('switching portals refills the table in the same cell', () => {
    const { map, portals } = portalHall();
    const lights = createHeadlightGlows();
    const at = rider(2.5, 4.5, -Math.PI / 2);
    const off = only(lights.update([at], map, null)).shadow?.seen.slice();
    const on = only(lights.update([at], map, portals)).shadow?.seen;
    expect(on).toBeDefined();
    expect([...(on ?? [])]).not.toEqual([...(off ?? [])]);
  });

  test('a rider missing from an update is dropped, and on return gets a fresh glow', () => {
    const lights = createHeadlightGlows();
    const before = only(lights.update([rider(4.5, 2.5)], open, null));
    expect(lights.update([], open, null)).toHaveLength(0);
    const after = only(lights.update([rider(4.5, 2.5)], open, null));
    expect(after).not.toBe(before);
  });

  test('the same glow objects are reused from frame to frame', () => {
    const lights = createHeadlightGlows();
    const a = lights.update([rider(4.5, 2.5), rider(4.5, 1.5, EAST, 'b')], open, null);
    const first = [...a];
    const b = lights.update([rider(4.6, 2.5), rider(4.6, 1.5, EAST, 'b')], open, null);
    expect(b).toBe(a);
    expect(b.at(0)).toBe(first.at(0));
    expect(b.at(1)).toBe(first.at(1));
  });
});
