import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { type Glow, glowLight } from './glow';
import {
  createHeadlightGlows,
  HEADLIGHT_AHEAD_TILES,
  HEADLIGHT_COLOUR,
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

function only(glows: readonly Glow[]): Glow {
  const g = glows.at(0);
  if (!g || glows.length !== 1) {
    throw new Error(`expected one glow, got ${glows.length}`);
  }
  return g;
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
    expect(g.r).toBeCloseTo(HEADLIGHT_COLOUR.r * HEADLIGHT_STRENGTH);
    expect(g.b).toBeCloseTo(HEADLIGHT_COLOUR.b * HEADLIGHT_STRENGTH);
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
