import { describe, expect, test } from 'vitest';
import { PLAYER_RADIUS, type PlayerState, stepPlayer } from '../geometry/movement';
import { isWallAt, parseMap } from '../map/map';
import { carryThroughPortal, crossedPortal } from './crossing';
import { invert, type RigidTransform } from './transform';
import type { Portal, Portals } from './wiring';

// Two doorways in the wall row y = 3: A at x = 2 (front north, back south), B at x = 4 (front south, back north).
const MAP = parseMap('1111111\n1.....1\n1..S..1\n11.1.11\n1.....1\n1.....1\n1111111');

// A half turn about the middle of the wall (3.5, 3.5): A's centre lands on B's and the other way round.
const HALF_TURN_ABOUT_WALL_MIDDLE: RigidTransform = { cos: -1, sin: 0, tx: 7, ty: 7 };

function portalAt(x: number, to: number, ny: number): Portal {
  return {
    door: { x, y: 3, axis: 'ns' },
    cx: x + 0.5,
    cy: 3.5,
    nx: 0,
    ny,
    to,
    toDest: HALF_TURN_ABOUT_WALL_MIDDLE,
    fromDest: invert(HALF_TURN_ABOUT_WALL_MIDDLE),
  };
}

const A = 0;
const B = 1;
const PORTALS: Portals = {
  map: MAP,
  list: [portalAt(2, B, 1), portalAt(4, A, -1)],
  byTile: Int32Array.from({ length: MAP.width * MAP.height }, (_, tile) => {
    const tileX = tile % MAP.width;
    const tileY = Math.floor(tile / MAP.width);
    return tileY === 3 && tileX === 2 ? A : tileY === 3 && tileX === 4 ? B : -1;
  }),
};

const player = (x: number, y: number, angle = 0): PlayerState => ({ x, y, angle });
const FACING_SOUTH = Math.PI / 2;

function boxInWall(p: PlayerState): boolean {
  const r = PLAYER_RADIUS;
  return [
    [p.x - r, p.y - r],
    [p.x + r, p.y - r],
    [p.x - r, p.y + r],
    [p.x + r, p.y + r],
  ].some(([x, y]) => isWallAt(MAP, x as number, y as number));
}

describe('crossedPortal', () => {
  test('a segment crossing the plane front to back finds the portal and the fraction at the plane', () => {
    const out = { t: -1 };
    expect(crossedPortal(PORTALS, 2.5, 3.3, 2.5, 3.8, out)).toBe(A);
    expect(out.t).toBeCloseTo(0.4);
  });

  test('a segment crossing the plane back to front finds nothing', () => {
    expect(crossedPortal(PORTALS, 2.5, 3.8, 2.5, 3.2, { t: 0 })).toBe(-1);
  });

  test('the front of B is the south side', () => {
    expect(crossedPortal(PORTALS, 4.5, 3.8, 4.5, 3.2, { t: 0 })).toBe(B);
    expect(crossedPortal(PORTALS, 4.5, 3.2, 4.5, 3.8, { t: 0 })).toBe(-1);
  });

  test('a segment crossing the plane line outside the opening, in the side wall, finds nothing', () => {
    expect(crossedPortal(PORTALS, 1.5, 3.2, 1.5, 3.8, { t: 0 })).toBe(-1);
    expect(crossedPortal(PORTALS, 3.5, 3.2, 3.5, 3.8, { t: 0 })).toBe(-1);
  });

  test('a segment that stops short of the plane finds nothing', () => {
    expect(crossedPortal(PORTALS, 2.5, 3.1, 2.5, 3.4, { t: 0 })).toBe(-1);
  });

  test('a segment leaving from exactly on the plane finds nothing', () => {
    expect(crossedPortal(PORTALS, 2.5, 3.5, 2.5, 3.8, { t: 0 })).toBe(-1);
  });
});

describe('carryThroughPortal', () => {
  test('without portals it changes nothing', () => {
    const pose = player(2.5, 3.8, FACING_SOUTH);
    expect(carryThroughPortal(null, 2.5, 3.3, pose)).toBe(false);
    expect(pose).toEqual(player(2.5, 3.8, FACING_SOUTH));
  });

  test('carries the part of the move past the plane through the destination and rotates the velocity', () => {
    const pose = player(2.4, 3.8, FACING_SOUTH);
    const velocity = { vx: 1, vy: 2 };
    expect(carryThroughPortal(PORTALS, 2.4, 3.3, pose, velocity)).toBe(true);
    expect(pose.x).toBeCloseTo(4.6);
    expect(pose.y).toBeCloseTo(3.2);
    expect(pose.angle).toBeCloseTo(FACING_SOUTH + Math.PI);
    expect(velocity.vx).toBeCloseTo(-1);
    expect(velocity.vy).toBeCloseTo(-2);
  });
});

describe('stepPlayer through a portal', () => {
  const walkSouth = { forward: 1, strafe: 0, turn: 0 };

  test('walking front to back through A ends on B back side, turned by the transform', () => {
    const p = stepPlayer(MAP, player(2.5, 3.3, FACING_SOUTH), walkSouth, 0.1, player(0, 0), PORTALS);
    expect(p.x).toBeCloseTo(4.5);
    expect(p.y).toBeCloseTo(3.4);
    expect(p.angle).toBeCloseTo(FACING_SOUTH + Math.PI);
  });

  test('stepping in place (out is the state) still goes through', () => {
    const pose = player(2.5, 3.3, FACING_SOUTH);
    stepPlayer(MAP, pose, walkSouth, 0.1, pose, PORTALS);
    expect(pose.x).toBeCloseTo(4.5);
    expect(pose.y).toBeCloseTo(3.4);
    expect(pose.angle).toBeCloseTo(FACING_SOUTH + Math.PI);
  });

  test('the same input without portals ends where it always did', () => {
    const p = stepPlayer(MAP, player(2.5, 3.3, FACING_SOUTH), walkSouth, 0.1, player(0, 0));
    expect(p.x).toBeCloseTo(2.5);
    expect(p.y).toBeCloseTo(3.6);
    expect(p.angle).toBeCloseTo(FACING_SOUTH);
  });

  test('keeps walking out of B instead of crossing back', () => {
    let p = stepPlayer(MAP, player(2.5, 3.3, FACING_SOUTH), walkSouth, 0.1, player(0, 0), PORTALS);
    for (let i = 0; i < 5; i++) {
      p = stepPlayer(MAP, p, walkSouth, 0.1, player(0, 0), PORTALS);
    }
    expect(p.x).toBeCloseTo(4.5);
    expect(p.y).toBeLessThan(3);
  });

  test('close to the side wall, strafing into it while walking through, comes out at B and not in a wall', () => {
    const closeToWall = player(2 + PLAYER_RADIUS + 0.05, 3.4, FACING_SOUTH);
    const strafeIntoWall = { forward: 1, strafe: 1, turn: 0 };
    let p = stepPlayer(MAP, closeToWall, strafeIntoWall, 0.1, player(0, 0), PORTALS);
    expect(p.y).toBeLessThan(3.5);
    expect(p.x).toBeGreaterThan(4);
    expect(isWallAt(MAP, p.x, p.y)).toBe(false);
    expect(boxInWall(p)).toBe(false);
    for (let i = 0; i < 5; i++) {
      p = stepPlayer(MAP, p, strafeIntoWall, 0.1, player(0, 0), PORTALS);
      expect(boxInWall(p)).toBe(false);
    }
  });

  test('standing in the front half of A with no input never jumps', () => {
    const standing = player(2.5, 3.3, FACING_SOUTH);
    let p = standing;
    for (let i = 0; i < 5; i++) {
      p = stepPlayer(MAP, p, { forward: 0, strafe: 0, turn: 0 }, 0.1, player(0, 0), PORTALS);
    }
    expect(p).toEqual(standing);
  });

  test('standing exactly on a plane with no input never jumps', () => {
    const onPlane = player(4.5, 3.5, FACING_SOUTH);
    const p = stepPlayer(MAP, onPlane, { forward: 0, strafe: 0, turn: 0 }, 0.1, player(0, 0), PORTALS);
    expect(p).toEqual(onPlane);
  });
});
