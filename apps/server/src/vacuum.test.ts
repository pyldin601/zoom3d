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

describe('bumping into people', () => {
  const OPEN = room([
    '11111111111',
    '1S........1',
    '1.........1',
    '1.........1',
    '1.........1',
    '1.........1',
    '1.........1',
    '1.........1',
    '1.........1',
    '11111111111',
  ]);

  /** A robot at (2.5, 5.5) facing +x, heading for (8.5, 5.5). */
  function driving(angle = 0) {
    const nav = createVacuumNav(OPEN);
    const v = createVacuum(nav, seeded(), 'v1');
    Object.assign(v, { x: 2.5, y: 5.5, angle, waypoints: [{ x: 8.5, y: 5.5 }], deadline: 1e9, patch: null });
    return { nav, v };
  }

  test('bumps a person ahead once, pauses, turns aside and drives round them', () => {
    const { nav, v } = driving();
    const person = { x: 3.5, y: 5.5 };
    const events: { t: number; e: string }[] = [];
    const poses: { t: number; x: number; y: number; angle: number }[] = [];
    for (let t = 0; t < 15; t += DT) {
      const e = stepVacuum(nav, v, DT, seeded(), [person]);
      if (e) {
        events.push({ t, e });
      }
      poses.push({ t, x: v.x, y: v.y, angle: v.angle });
    }
    expect(events.map((e) => e.e)).toEqual(['bump']);
    const bumpAt = (events[0] as { t: number }).t;
    const after = poses.filter((p) => p.t > bumpAt);
    const still = after.findIndex((p) => p.x !== after[0]?.x || p.y !== after[0]?.y || p.angle !== after[0]?.angle);
    expect(still * DT).toBeGreaterThanOrEqual(0.2);
    expect(still * DT).toBeLessThanOrEqual(0.4);
    const turned = after.find((p) => Math.abs(Math.abs(p.angle - Math.PI) - Math.PI / 2) < 1e-6);
    expect(turned).toBeDefined();
    expect(v.x).toBeGreaterThan(person.x + 1);
  });

  test('ignores people behind it and people beside it beyond 0.6', () => {
    const { nav, v } = driving();
    for (let t = 0; t < 5; t += DT) {
      const behind = { x: v.x - 0.3, y: v.y };
      const beside = { x: v.x + 0.1, y: v.y + 0.65 };
      expect(stepVacuum(nav, v, DT, seeded(), [behind, beside])).toBeNull();
    }
    expect(v.x).toBeGreaterThan(4);
  });

  test('never bumps while turning in place', () => {
    const { nav, v } = driving(Math.PI);
    const person = { x: 3.0, y: 5.5 };
    let bumps = 0;
    for (let t = 0; t < 5; t += DT) {
      const before = v.angle;
      const e = stepVacuum(nav, v, DT, seeded(), [person]);
      if (e === 'bump') {
        bumps++;
        expect(v.angle).toBe(before);
      }
    }
    expect(bumps).toBeGreaterThanOrEqual(1);
  });

  test('a person parked on a waypoint is skipped', () => {
    const nav = createVacuumNav(OPEN);
    const v = createVacuum(nav, seeded(), 'v1');
    stepVacuum(nav, v, DT, seeded(), []);
    const parked = v.waypoints[2] as { x: number; y: number };
    const person = { x: parked.x, y: parked.y };
    let t = 0;
    while (v.waypoints.includes(parked) && t < 30) {
      stepVacuum(nav, v, DT, seeded(), [person]);
      t += DT;
    }
    expect(v.waypoints.includes(parked)).toBe(false);
    expect(t).toBeLessThan(20);
    expect(v.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe('blocked with no room to go round', () => {
  /** Two rooms joined by a one-tile door at (6, 3). */
  const DOOR = room([
    '1111111111111',
    '1S....1.....1',
    '1.....1.....1',
    '1...........1',
    '1.....1.....1',
    '1.....1.....1',
    '1111111111111',
  ]);

  test('a person just past a doorway gets one thud, not one every half second', () => {
    const nav = createVacuumNav(DOOR);
    const v = createVacuum(nav, seeded(), 'v1');
    Object.assign(v, { x: 5.5, y: 3.5, angle: 0, waypoints: [{ x: 10.5, y: 3.5 }], deadline: 1e9, patch: null });
    const person = { x: 6.95, y: 3.5 };
    let bumps = 0;
    for (let t = 0; t < 120; t += DT) {
      if (stepVacuum(nav, v, DT, seeded(), [person]) === 'bump') {
        bumps++;
      }
    }
    expect(bumps).toBeGreaterThanOrEqual(1);
    expect(bumps).toBeLessThanOrEqual(3);
  });
});
