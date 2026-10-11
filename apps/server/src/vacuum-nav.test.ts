import { hasLineOfSight, isWallAt, LEVEL1, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createVacuumNav, mapFingerprint, type Point, VACUUM_RADIUS } from './vacuum-nav';

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

  test('a full 3×3 floor patch routes the 20-point ring before the 16 inner points', () => {
    const open = createVacuumNav(OPEN);
    const patch = open.patchOf(4, 4);
    const route = open.route(patch, { x: 3.5, y: 3.5 });
    expect(route).toHaveLength(36);
    const onRing = (p: Point) => [p.x - 3, p.y - 3].some((v) => v === 0.25 || v === 2.75);
    expect(route.slice(0, 20).every(onRing)).toBe(true);
    expect(route.slice(20).some(onRing)).toBe(false);
  });

  test('route starts at the ring point nearest from', () => {
    const open = createVacuumNav(OPEN);
    const route = open.route(open.patchOf(4, 4), { x: 6.9, y: 4.6 });
    expect(route[0]).toEqual({ x: 5.75, y: 4.75 });
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
        const a = route[i - 1] as Point;
        const b = route[i] as Point;
        expect(hasLineOfSight(level, a.x, a.y, b.x, b.y), `patch ${patch} step ${i}`).toBe(true);
      }
    }
  });

  test('path reaches the target tile centre and agrees with distances', () => {
    const from = { x: level.spawn.x + 0.5, y: level.spawn.y + 0.5 };
    const to = { x: 1, y: 13 };
    const path = nav.path(from, to);
    expect(path.at(-1)).toEqual({ x: 1.5, y: 13.5 });
    expect(nav.distances(from)[to.y * level.width + to.x]).toBe(path.length);
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
