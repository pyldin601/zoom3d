import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { type Glow, glowLight } from './glow';
import {
  createHeadlightGlows,
  HEADLIGHT_AHEAD_TILES,
  HEADLIGHT_COLOUR,
  HEADLIGHT_CONE_HALF_RAD,
  HEADLIGHT_FRINGE_RAD,
  HEADLIGHT_FRINGE_SHARE,
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

/** One rider's lamp: its white glow, then its red, green and blue fringe glows. */
function lampOf(glows: readonly Glow[]): [Glow, Glow, Glow, Glow] {
  const [white, red, green, blue] = glows;
  if (!white || !red || !green || !blue || glows.length !== 4) {
    throw new Error(`expected one lamp of four glows, got ${glows.length} glows`);
  }
  return [white, red, green, blue];
}

/** One rider's white glow, which carries most of the light. */
const only = (glows: readonly Glow[]): Glow => lampOf(glows)[0];

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

  test('a lamp is a white glow with most of the light and a faint red, green and blue fringe, adding up to its colour', () => {
    const [white, red, green, blue] = lampOf(createHeadlightGlows().update([rider(5.5, 2.5)], open, null));
    const full = (c: number) => c * HEADLIGHT_STRENGTH;
    const fringe = (c: number) => c * HEADLIGHT_STRENGTH * HEADLIGHT_FRINGE_SHARE;
    expect(white.r).toBeCloseTo(full(HEADLIGHT_COLOUR.r) - fringe(HEADLIGHT_COLOUR.r));
    expect(white.b).toBeCloseTo(full(HEADLIGHT_COLOUR.b) - fringe(HEADLIGHT_COLOUR.b));
    expect([red.r, red.g, red.b]).toEqual([fringe(HEADLIGHT_COLOUR.r), 0, 0]);
    expect([green.r, green.g, green.b]).toEqual([0, fringe(HEADLIGHT_COLOUR.g), 0]);
    expect([blue.r, blue.g, blue.b]).toEqual([0, 0, fringe(HEADLIGHT_COLOUR.b)]);
    expect(HEADLIGHT_FRINGE_SHARE).toBeLessThanOrEqual(0.25);
    // One shadow table for all four: walls block every colour the same.
    for (const g of [red, green, blue]) {
      expect(g.shadow).toBe(white.shadow);
      expect([g.x, g.y]).toEqual([white.x, white.y]);
    }
  });

  test('just past the white beam only a thin blue line is left, and well inside every glow lights', () => {
    const [white, red, green, blue] = lampOf(createHeadlightGlows().update([rider(5.5, 2.5)], open, null));
    const lamp = 5.5 + HEADLIGHT_AHEAD_TILES;
    const atDeg = (deg: number) =>
      [lamp + 2 * Math.cos((deg * Math.PI) / 180), 2.5 + 2 * Math.sin((deg * Math.PI) / 180)] as const;
    for (const g of [white, red, green, blue]) {
      expect(floorLight(g, ...atDeg(5))).toBeGreaterThan(0);
    }
    const halfDeg = (HEADLIGHT_CONE_HALF_RAD * 180) / Math.PI;
    const spacingDeg = (HEADLIGHT_FRINGE_RAD * 180) / Math.PI;
    const line = atDeg(halfDeg + spacingDeg);
    expect(floorLight(blue, ...line)).toBeGreaterThan(0);
    expect(floorLight(white, ...line)).toBe(0);
    expect(floorLight(green, ...line)).toBe(0);
    expect(floorLight(red, ...line)).toBe(0);
    // The line is thin: two spacings past the white edge, nothing at all.
    for (const g of [white, red, green, blue]) {
      expect(floorLight(g, ...atDeg(halfDeg + 2 * spacingDeg))).toBe(0);
    }
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
