import { hasLineOfSight, isWallAt, LEVEL1, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createVacuumNav, mapFingerprint, type Point, VACUUM_RADIUS } from './nav';
import { defined } from './test-helpers';

// Robot vacuum spec §3.3: the map is cleaned in 3×3-tile patches, edge first, then lanes.
const level = parseMap(LEVEL1);
const nav = createVacuumNav(level);

/** An open 11×11 room: patch (1, 1) covers tiles 3..5 with floor all round it. */
const OPEN = parseMap(
  [
    '11111111111',
    ...Array.from({ length: 9 }, (_, i) => (i === 0 ? '1S........1' : '1.........1')),
    '11111111111',
  ].join('\n')
);

const clear = (map: typeof level, p: Point) =>
  [-VACUUM_RADIUS, VACUUM_RADIUS].every((dx) =>
    [-VACUUM_RADIUS, VACUUM_RADIUS].every((dy) => !isWallAt(map, p.x + dx, p.y + dy))
  );

describe('createVacuumNav', () => {
  test('LEVEL1 has 164 dirty patches', () => {
    expect(nav.dirtyAtStart).toHaveLength(164);
    expect(nav.floor).toHaveLength(989);
  });

  test('a full 3×3 floor patch routes the 16-point ring before the 9 inner points', () => {
    const open = createVacuumNav(OPEN);
    const patch = open.patchOf(4, 4);
    const route = open.route(patch, { x: 3.5, y: 3.5 });
    expect(route).toHaveLength(25);
    const onRing = (p: Point) => [p.x - 3, p.y - 3].some((v) => Math.abs(v - 0.3) < 1e-9 || Math.abs(v - 2.7) < 1e-9);
    expect(route.slice(0, 16).every(onRing)).toBe(true);
    expect(route.slice(16).some(onRing)).toBe(false);
  });

  test('route starts at the ring point nearest from', () => {
    const open = createVacuumNav(OPEN);
    const route = open.route(open.patchOf(4, 4), { x: 6.9, y: 5.2 });
    expect(route.at(0)?.x).toBeCloseTo(5.7);
    expect(route.at(0)?.y).toBeCloseTo(5.1);
  });

  test('route points keep the robot clear of walls', () => {
    for (const patch of nav.dirtyAtStart) {
      for (const p of nav.route(patch, { x: 0, y: 0 })) {
        expect(clear(level, p), `patch ${patch} point ${p.x},${p.y}`).toBe(true);
      }
    }
  });

  test('consecutive route points always have line of sight', () => {
    for (const patch of nav.dirtyAtStart) {
      const route = nav.route(patch, { x: 0, y: 0 });
      for (let i = 1; i < route.length; i++) {
        const a = defined(route.at(i - 1), 'point');
        const b = defined(route.at(i), 'point');
        expect(hasLineOfSight(level, a.x, a.y, b.x, b.y), `patch ${patch} step ${i}`).toBe(true);
      }
    }
  });

  test('path reaches the target tile centre and agrees with distances', () => {
    const from = { x: level.spawn.x + 0.5, y: level.spawn.y + 0.5 };
    const to = { x: 1, y: 13 };
    const path = nav.path(from, to);
    expect(path.at(-1)).toEqual({ x: 1.5, y: 13.5 });
    expect(nav.distances(from)(to)).toBe(path.length);
    expect(nav.path(from, from)).toEqual([]);
  });
});

describe('mapFingerprint', () => {
  test('is stable for the same text and changes when one tile changes', () => {
    expect(mapFingerprint(parseMap(LEVEL1))).toBe(mapFingerprint(level));
    expect(mapFingerprint(level)).toMatch(/^[0-9a-f]{8}$/);
    const edited = LEVEL1.replace('.S', '1S');
    expect(mapFingerprint(parseMap(edited))).not.toBe(mapFingerprint(level));
  });
});
