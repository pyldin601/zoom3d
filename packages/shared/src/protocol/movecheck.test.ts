import { describe, expect, test } from 'vitest';
import { parseMap } from '../map/map';
import { invert, type RigidTransform } from '../portals/transform';
import type { Portal, Portals } from '../portals/wiring';
import { isPlausibleMove } from './movecheck';

const ROOM = parseMap('11111\n1...1\n1.S.1\n1...1\n11111');

test('a normal step is plausible', () => {
  expect(isPlausibleMove(ROOM, { x: 2.5, y: 2.5 }, { x: 2.8, y: 2.5 }, 100)).toBe(true);
});

test('a teleport is not', () => {
  expect(isPlausibleMove(ROOM, { x: 1.5, y: 1.5 }, { x: 3.5, y: 3.5 }, 100)).toBe(false);
});

test('a wall target is never plausible', () => {
  expect(isPlausibleMove(ROOM, { x: 2.5, y: 2.5 }, { x: 4.5, y: 2.5 }, 100_000)).toBe(false);
});

test('half a tile of slack even with no elapsed time', () => {
  expect(isPlausibleMove(ROOM, { x: 2.5, y: 2.5 }, { x: 3.0, y: 2.5 }, 0)).toBe(true);
});

describe('with portals', () => {
  // Two rooms 20 tiles apart above one hall; doorways A (2, 3) and B (22, 3) look at each other through a half turn.
  const wall = '1'.repeat(25);
  const roomsRow = `1...1${'1'.repeat(15)}1...1`;
  const hall = `1${'.'.repeat(23)}1`;
  const doorRow = `11.1${'1'.repeat(17)}1.11`;
  const FAR_ROOMS = parseMap(
    [wall, roomsRow, `1S.${'.'}1${'1'.repeat(15)}1...1`, doorRow, hall, hall, wall].join('\n')
  );
  const A_TO_B: RigidTransform = { cos: -1, sin: 0, tx: 25, ty: 7 };
  const portal = (x: number, ny: number, to: number, toDest: RigidTransform): Portal => ({
    door: { x, y: 3, axis: 'ns' },
    cx: x + 0.5,
    cy: 3.5,
    nx: 0,
    ny,
    to,
    toDest,
    fromDest: invert(toDest),
  });
  const list = [portal(2, 1, 1, A_TO_B), portal(22, -1, 0, invert(A_TO_B))];
  const byTile = new Int32Array(FAR_ROOMS.width * FAR_ROOMS.height).fill(-1);
  byTile[3 * FAR_ROOMS.width + 2] = 0;
  byTile[3 * FAR_ROOMS.width + 22] = 1;
  const portals: Portals = { map: FAR_ROOMS, list, byTile };
  const from = { x: 2.5, y: 1.5 };
  const behindB = { x: 22.5, y: 2.5 };

  test('a jump of 20 tiles that one portal explains is plausible', () => {
    expect(isPlausibleMove(FAR_ROOMS, from, behindB, 1000, portals)).toBe(true);
  });

  test('the same jump without portals is not', () => {
    expect(isPlausibleMove(FAR_ROOMS, from, behindB, 1000)).toBe(false);
    expect(isPlausibleMove(FAR_ROOMS, from, behindB, 1000, null)).toBe(false);
  });

  test('a teleport that no portal explains stays implausible', () => {
    expect(isPlausibleMove(FAR_ROOMS, from, { x: 12.5, y: 4.5 }, 100, portals)).toBe(false);
  });

  test('a wall target is still refused', () => {
    expect(isPlausibleMove(FAR_ROOMS, from, { x: 12.5, y: 2.5 }, 100_000, portals)).toBe(false);
  });
});
