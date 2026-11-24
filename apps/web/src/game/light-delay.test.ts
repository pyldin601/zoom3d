import {
  type GameMap,
  invert,
  type Portal,
  type Portals,
  parseMap,
  type RigidTransform,
  SnapshotBuffer,
} from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { createTrail, HISTORY_CAPACITY, type SeenLight, seenAt } from './light-delay';

const open = parseMap(
  ['11111111111111111111', ...Array.from({ length: 8 }, () => `1${'.'.repeat(18)}1`), '11111111111111111111']
    .join('\n')
    .replace('.', 'S')
);

/** A buffer of a thing walking from (x0, y) along x at `speed` tiles/s, sent every 66 ms for 10 s up to t = 10 000. */
function walker(x0: number, y: number, speed: number): SnapshotBuffer {
  const buffer = new SnapshotBuffer(HISTORY_CAPACITY * 2);
  for (let t = 0; t <= 10_000; t += 66) {
    buffer.push({ t, x: x0 + (speed * t) / 1000, y, angle: 0 });
  }
  return buffer;
}

const light = (lightSpeed: number): SeenLight => ({ map: open, portals: null, eye: { x: 2, y: 2 }, lightSpeed });
const pose = () => ({ x: 0, y: 0, angle: 0 });

test('a still thing is seen as it stands, d / c ago', () => {
  const out = pose();
  const t = seenAt(walker(14, 2, 0), light(12), 10_000, out);
  expect(out.x).toBeCloseTo(14, 6);
  expect(t).toBeCloseTo(9000, 0);
});

test('a moving thing is seen where it was when its light left', () => {
  const out = pose();
  const t = seenAt(walker(4, 2, 1), light(12), 10_000, out);
  const d = Math.hypot(out.x - 2, out.y - 2);
  expect(Math.abs(10_000 - t - (d / 12) * 1000)).toBeLessThan(30);
  expect(out.x).toBeLessThan(14);
});

test('a receding thing is seen more recently than an approaching one now as far: its light left from nearer', () => {
  const away = seenAt(walker(4, 2, 1), light(12), 10_000, pose());
  const toward = seenAt(walker(24, 2, -1), light(12), 10_000, pose());
  expect(10_000 - away).toBeLessThan(10_000 - toward);
});

/** How far `t` is from the light time of what `out` holds: the time light takes from there to the eye, in ms. */
const lightTimeError = (t: number, drawnAt: number, out: { x: number; y: number }, c: number) =>
  Math.abs(drawnAt - t - (Math.hypot(out.x - 2, out.y - 2) / c) * 1000);

test.each([
  ['away at 2/3 c', 3, 8, 12],
  ['away faster than light', 3, 8, 6],
  ['toward at 2/3 c', 17, -8, 12],
])('a fast thing moving %s is seen at its light time', (_, x0, speed, c) => {
  const out = pose();
  const t = seenAt(walker(x0, 2, speed), light(c), 1500, out);
  expect(lightTimeError(t, 1500, out, c)).toBeLessThan(0.5);
});

test('a ball kicked away is seen leaving once its light from the kick arrives', () => {
  const buffer = new SnapshotBuffer(HISTORY_CAPACITY);
  for (let t = 0; t <= 3500; t += 66) {
    buffer.push({ t, x: t < 3000 ? 2.6 : 2.6 + (8 * (t - 3000)) / 1000, y: 2, angle: 0 });
  }
  const out = pose();
  const t = seenAt(buffer, light(6), 3500, out);
  expect(lightTimeError(t, 3500, out, 6)).toBeLessThan(0.5);
  expect(out.x).toBeGreaterThan(3);
});

test('faster than light stays finite', () => {
  const out = pose();
  expect(Number.isFinite(seenAt(walker(3, 2, 30), light(6), 10_000, out))).toBe(true);
  expect(Number.isFinite(out.x)).toBe(true);
});

/**
 * The shared package's two rooms above a hall: doorway A at (2, 3) front north, B at (6, 3) front south, a half turn
 * about (4.5, 3.5) between them. From (2.5, 1.5) a thing just behind B, at (6.5, 2.5), is seen through A at (2.5, 4.5).
 */
function twoRooms(): { map: GameMap; portals: Portals } {
  const map = parseMap('111111111\n1...1...1\n1S..1...1\n11.111.11\n1.......1\n1.......1\n111111111');
  const aToB: RigidTransform = { cos: -1, sin: 0, tx: 9, ty: 7 };
  const portalAt = (x: number, ny: number, to: number, toDest: RigidTransform): Portal => ({
    door: { x, y: 3, axis: 'ns' },
    cx: x + 0.5,
    cy: 3.5,
    nx: 0,
    ny,
    to,
    toDest,
    fromDest: invert(toDest),
  });
  const byTile = new Int32Array(map.width * map.height).fill(-1);
  byTile[3 * map.width + 2] = 0;
  byTile[3 * map.width + 6] = 1;
  return { map, portals: { map, list: [portalAt(2, 1, 1, aToB), portalAt(6, -1, 0, invert(aToB))], byTile } };
}

test('through a portal the delay follows the image, not the straight line', () => {
  const { map, portals } = twoRooms();
  const t = seenAt(walker(6.5, 2.5, 0), { map, portals, eye: { x: 2.5, y: 1.5 }, lightSpeed: 6 }, 10_000, pose());
  expect(10_000 - t).toBeCloseTo((3 / 6) * 1000, 3);
});

test('an empty buffer is not seen', () => {
  expect(seenAt(new SnapshotBuffer(), light(12), 10_000, pose())).toBeNaN();
});

test('a trail pushed every frame at 144 Hz still holds several seconds', () => {
  const trail = createTrail();
  for (let t = 0; t <= 6000; t += 7) {
    trail.push(t, t / 1000, 0, 0);
  }
  const out = pose();
  trail.buffer.sample(1000, out);
  expect(out.x).toBeCloseTo(1, 1);
  // The newest entry follows the present: the last push, at t = 5999.
  trail.buffer.sample(5999, out);
  expect(out.x).toBeCloseTo(5.999, 6);
});
