import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import {
  createLighterGlows,
  LIGHTER_COLOUR,
  LIGHTER_FLICKER,
  LIGHTER_REACH,
  LIGHTER_STRENGTH,
  lighterFlicker,
} from './lighter';
import { FLOOR_SUB } from './lighting';
import { portalHall } from './test-portals';

// An open 9×5 room; the second copy has a pillar at (4, 2), which a table filled on it would show.
const open = parseMap(`
111111111
1S......1
1.......1
1.......1
111111111
`);
const pillar = parseMap(`
111111111
1S......1
1...1...1
1.......1
111111111
`);
const source = (x: number, y: number, angle = 0, key = 'a') => ({ key, x, y, angle });

/** The shadow table's value for the floor cell holding (x, y). */
function seenAt(glow: ReturnType<ReturnType<typeof createLighterGlows>['update']>[number], x: number, y: number) {
  const shadow = glow.shadow;
  if (!shadow) {
    throw new Error('no shadow table');
  }
  const col = Math.floor(x * FLOOR_SUB) - shadow.firstCol;
  const row = Math.floor(y * FLOOR_SUB) - shadow.firstRow;
  return shadow.seen[row * shadow.across + col];
}

describe('createLighterGlows', () => {
  test('one source gives one glow at it, reaching LIGHTER_REACH, shadowed, its cone along its angle', () => {
    const glows = createLighterGlows().update([source(2.5, 2.5, Math.PI / 2)], open, null, 0);
    expect(glows).toHaveLength(1);
    const g = glows.at(0);
    expect([g?.x, g?.y, g?.reach]).toEqual([2.5, 2.5, LIGHTER_REACH]);
    expect(g?.shadow).not.toBeNull();
    expect(g?.cone?.dx).toBeCloseTo(0);
    expect(g?.cone?.dy).toBeCloseTo(1);
  });

  test('its colour is the lighter colour times strength times the flicker', () => {
    const t = 1.37;
    const g = createLighterGlows()
      .update([source(2.5, 2.5)], open, null, t)
      .at(0);
    const k = LIGHTER_STRENGTH * lighterFlicker(t, 'a');
    expect(g?.r).toBeCloseTo(LIGHTER_COLOUR.r * k);
    expect(g?.g).toBeCloseTo(LIGHTER_COLOUR.g * k);
    expect(g?.b).toBeCloseTo(LIGHTER_COLOUR.b * k);
  });

  test('moving within one floor cell keeps the table; moving to another cell refills it', () => {
    const lighters = createLighterGlows();
    const first = lighters.update([source(2.5, 2.5)], open, null, 0).at(0);
    if (!first) {
      throw new Error('no glow');
    }
    expect(seenAt(first, 5.5, 2.5)).toBeGreaterThan(0);
    // Same cell, on the pillar map: a refill would put the far floor in the pillar's shadow.
    const same = lighters.update([source(2.5 + 0.2 / FLOOR_SUB, 2.5)], pillar, null, 0).at(0);
    if (!same) {
      throw new Error('no glow');
    }
    expect(seenAt(same, 5.5, 2.5)).toBeGreaterThan(0);
    const moved = lighters.update([source(2.5 + 1 / FLOOR_SUB, 2.5)], pillar, null, 0).at(0);
    if (!moved) {
      throw new Error('no glow');
    }
    expect(seenAt(moved, 5.5, 2.5)).toBe(0);
  });

  test('turning on the spot turns the cone at once, keeping the table', () => {
    const lighters = createLighterGlows();
    lighters.update([source(2.5, 2.5, 0)], open, null, 0);
    const turned = lighters.update([source(2.5, 2.5, Math.PI)], pillar, null, 0).at(0);
    if (!turned) {
      throw new Error('no glow');
    }
    expect(turned.cone?.dx).toBeCloseTo(-1);
    expect(seenAt(turned, 5.5, 2.5)).toBeGreaterThan(0);
  });

  test('portals switched while standing still refill the table', () => {
    const { map, portals } = portalHall();
    const lighters = createLighterGlows();
    // South of doorway A, behind it: with portals on, the floor north of A sees through it to B's side instead.
    const at = source(2.5, 4.5);
    const off = lighters.update([at], map, null, 0).at(0)?.shadow?.seen.slice();
    const on = lighters.update([at], map, portals, 0).at(0)?.shadow?.seen;
    expect(on).toBeDefined();
    expect(off).toBeDefined();
    expect([...(on ?? [])]).not.toEqual([...(off ?? [])]);
  });

  test('a source missing from an update is not drawn, and on return is shadowed for where it is then', () => {
    const lighters = createLighterGlows();
    lighters.update([source(2.5, 2.5)], open, null, 0);
    expect(lighters.update([], open, null, 0)).toHaveLength(0);
    const back = lighters.update([source(2.5, 2.5)], pillar, null, 0).at(0);
    if (!back) {
      throw new Error('no glow');
    }
    expect(seenAt(back, 5.5, 2.5)).toBe(0);
  });

  test('two sources give two glows, in the same list and glow objects from call to call', () => {
    const lighters = createLighterGlows();
    const both = [source(2.5, 2.5, 0, 'a'), source(6.5, 2.5, 0, 'b')];
    const first = lighters.update(both, open, null, 0);
    const glows = [...first];
    const second = lighters.update(both, open, null, 0.5);
    expect(second).toBe(first);
    expect(second).toHaveLength(2);
    expect(second.at(0)).toBe(glows.at(0));
    expect(second.at(1)).toBe(glows.at(1));
  });
});

describe('lighterFlicker', () => {
  test('stays within LIGHTER_FLICKER either way', () => {
    for (let i = 0; i < 1000; i++) {
      const k = lighterFlicker(i * 0.013, 'someone');
      expect(k).toBeGreaterThanOrEqual(1 - LIGHTER_FLICKER);
      expect(k).toBeLessThanOrEqual(1 + LIGHTER_FLICKER);
    }
  });

  test('two holders flicker apart', () => {
    expect(lighterFlicker(2, 'a')).not.toBe(lighterFlicker(2, 'b'));
  });
});
