import { isWallAt, LEVEL1, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import {
  createVacuum,
  restoreVacuum,
  saveVacuum,
  stepVacuum,
  VACUUM_SPEED,
  VACUUM_TURN_SPEED,
  type Vacuum,
  vacuumInfo,
} from './vacuum';
import { createVacuumNav, VACUUM_RADIUS } from './vacuum-nav';

// Robot vacuum spec §3: cleans 3×3 patches one by one at a real robot's pace, then searches for its dock forever.
const DT = 0.1;

/** Deterministic but varied randomness, as in bots.test.ts. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const room = (rows: string[]) => parseMap(rows.join('\n'));

/** Two 5×5 rooms joined by a one-tile door. */
const TWO_ROOMS = room([
  '1111111111111',
  '1S....1.....1',
  '1.....1.....1',
  '1...........1',
  '1.....1.....1',
  '1.....1.....1',
  '1111111111111',
]);

/** A 9×9 room with one wall tile in the middle of patch (1, 1), so its lanes have to go round it. */
const PILLAR = room([
  '11111111111',
  '1S........1',
  '1.........1',
  '1.........1',
  '1...1.....1',
  '1.........1',
  '1.........1',
  '1.........1',
  '1.........1',
  '1.........1',
  '11111111111',
]);

const TINY = room(['111111', '1S...1', '1....1', '1....1', '111111']);

function run(nav: ReturnType<typeof createVacuumNav>, v: Vacuum, seconds: number, rng = seeded(3)) {
  const events: string[] = [];
  for (let t = 0; t < seconds; t += DT) {
    const e = stepVacuum(nav, v, DT, rng, []);
    if (e) {
      events.push(e);
    }
  }
  return events;
}

describe('createVacuum', () => {
  test('spawns on a floor tile centre, cleaning, nothing clean', () => {
    const nav = createVacuumNav(parseMap(LEVEL1));
    const v = createVacuum(nav, seeded(), 'v1');
    expect(v.x % 1).toBe(0.5);
    expect(v.y % 1).toBe(0.5);
    expect(isWallAt(nav.map, v.x, v.y)).toBe(false);
    expect(v.phase).toBe('cleaning');
    expect(v.clean.size).toBe(0);
    expect(vacuumInfo(v)).toEqual({ id: 'v1', kind: 'vacuum', x: v.x, y: v.y, angle: v.angle });
  });

  test('nearlyDone leaves exactly one dirty patch: the one it spawns in', () => {
    const nav = createVacuumNav(parseMap(LEVEL1));
    const v = createVacuum(nav, seeded(), 'v1', { nearlyDone: true });
    expect(v.clean.size).toBe(nav.dirtyAtStart.length - 1);
    expect(v.clean.has(nav.patchOf(Math.floor(v.x), Math.floor(v.y)))).toBe(false);
  });
});

describe('stepVacuum', () => {
  test('turns in place before driving, at most at its turn speed', () => {
    const nav = createVacuumNav(TWO_ROOMS);
    const v = createVacuum(nav, seeded(), 'v1');
    let turned = 0;
    for (let i = 0; i < 2000; i++) {
      const before = { x: v.x, y: v.y, angle: v.angle };
      stepVacuum(nav, v, DT, seeded(i), []);
      let turn = Math.abs(v.angle - before.angle) % (Math.PI * 2);
      turn = Math.min(turn, Math.PI * 2 - turn);
      const moved = Math.hypot(v.x - before.x, v.y - before.y);
      expect(turn).toBeLessThanOrEqual(VACUUM_TURN_SPEED * DT + 1e-9);
      expect(turn > 1e-9 && moved > 1e-9, `step ${i} turned and moved`).toBe(false);
      if (turn > 1e-9) {
        turned++;
      }
    }
    expect(turned).toBeGreaterThan(10);
  });

  test('never moves faster than 0.6 tiles/s', () => {
    const nav = createVacuumNav(TWO_ROOMS);
    const v = createVacuum(nav, seeded(), 'v1');
    for (let i = 0; i < 2000; i++) {
      const before = { x: v.x, y: v.y };
      stepVacuum(nav, v, DT, seeded(i), []);
      expect(Math.hypot(v.x - before.x, v.y - before.y)).toBeLessThanOrEqual(VACUUM_SPEED * DT + 1e-9);
    }
  });

  test('cleans the patch it starts in first', () => {
    const nav = createVacuumNav(TWO_ROOMS);
    const v = createVacuum(nav, seeded(), 'v1');
    const start = nav.patchOf(Math.floor(v.x), Math.floor(v.y));
    while (v.clean.size === 0) {
      stepVacuum(nav, v, DT, seeded(), []);
    }
    expect([...v.clean]).toEqual([start]);
  });

  test('a patch with a wall in its middle is cleaned without giving up on a point', () => {
    const nav = createVacuumNav(PILLAR);
    const v = createVacuum(nav, seeded(), 'v1');
    run(nav, v, 30 * 60);
    expect(v.phase).toBe('searching');
    expect(v.skipped).toBe(0);
  });

  test('switches to searching only when every patch is clean', () => {
    const nav = createVacuumNav(TINY);
    const v = createVacuum(nav, seeded(), 'v1');
    let steps = 0;
    while (v.phase === 'cleaning') {
      stepVacuum(nav, v, DT, seeded(), []);
      expect(++steps).toBeLessThan(20 * 60 * 10);
    }
    expect(v.clean.size).toBe(nav.dirtyAtStart.length);
  });

  test('searching says lost after each slow circle and never ends', () => {
    const nav = createVacuumNav(TWO_ROOMS);
    const v = createVacuum(nav, seeded(), 'v1', { nearlyDone: true });
    run(nav, v, 10 * 60);
    expect(v.phase).toBe('searching');
    const rng = seeded(5);
    let lost = 0;
    for (let t = 0; t < 10 * 60; t += DT) {
      if (stepVacuum(nav, v, DT, rng, []) === 'lost') {
        lost++;
      }
      expect(v.phase).toBe('searching');
      for (const dx of [-VACUUM_RADIUS, VACUUM_RADIUS]) {
        for (const dy of [-VACUUM_RADIUS, VACUUM_RADIUS]) {
          expect(isWallAt(nav.map, v.x + dx * 0.99, v.y + dy * 0.99)).toBe(false);
        }
      }
    }
    expect(lost).toBeGreaterThanOrEqual(3);
  });

  test('a full LEVEL1 clean takes 50 min – 2 h', () => {
    const nav = createVacuumNav(parseMap(LEVEL1));
    const v = createVacuum(nav, seeded(), 'v1');
    const rng = seeded(11);
    let t = 0;
    while (v.phase === 'cleaning' && t < 4 * 3600) {
      stepVacuum(nav, v, DT, rng, []);
      t += DT;
    }
    console.info(`full LEVEL1 clean: ${(t / 60).toFixed(1)} min, ${v.skipped} points given up`);
    expect(t).toBeGreaterThanOrEqual(50 * 60);
    expect(t).toBeLessThanOrEqual(120 * 60);
  });
});

describe('save and restore', () => {
  test('round-trips pose, phase and clean set', () => {
    const nav = createVacuumNav(TWO_ROOMS);
    const v = createVacuum(nav, seeded(), 'v1');
    run(nav, v, 5 * 60);
    const save = saveVacuum(nav, v);
    const back = restoreVacuum(nav, JSON.parse(JSON.stringify(save)));
    expect(back && vacuumInfo(back)).toEqual(vacuumInfo(v));
    expect(back?.phase).toBe(v.phase);
    expect(back && [...back.clean].sort()).toEqual([...v.clean].sort());
  });

  test('a different map or a pose inside a wall restores nothing', () => {
    const nav = createVacuumNav(TWO_ROOMS);
    const save = saveVacuum(nav, createVacuum(nav, seeded(), 'v1'));
    expect(restoreVacuum(nav, { ...save, map: 'deadbeef' })).toBeNull();
    expect(restoreVacuum(nav, { ...save, x: 0.5, y: 0.5 })).toBeNull();
    expect(restoreVacuum(createVacuumNav(TINY), save)).toBeNull();
  });
});
