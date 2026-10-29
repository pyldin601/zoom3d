import { describe, expect, test } from 'vitest';
import { hasLineOfSight } from '../geometry/los';
import { LEVEL1 } from '../map/level1';
import { type GameMap, parseMap } from '../map/map';
import { NEAR_TILES } from '../protocol/protocol';
import {
  type Apparent,
  apparentPosition,
  hasLineOfSightThrough,
  hasPortalLineOfSight,
  imagePosition,
  isNear,
} from './apparent';
import { twoDoorways } from './test-doorways';
import { invert, type RigidTransform } from './transform';
import { type Portal, type Portals, wirePortals } from './wiring';

interface PortalSpec {
  x: number;
  y: number;
  ny: number;
  to: number;
  toDest: RigidTransform;
}

function portalsOf(map: GameMap, specs: PortalSpec[]): Portals {
  const list: Portal[] = specs.map(({ x, y, ny, to, toDest }) => ({
    door: { x, y, axis: 'ns' },
    cx: x + 0.5,
    cy: y + 0.5,
    nx: 0,
    ny,
    to,
    toDest,
    fromDest: invert(toDest),
  }));
  const byTile = new Int32Array(map.width * map.height).fill(-1);
  for (const [i, portal] of list.entries()) {
    byTile[portal.door.y * map.width + portal.door.x] = i;
  }
  return { map, list, byTile };
}

const at = (x: number, y: number) => ({ x, y });
const blank = (): Apparent => ({ x: 0, y: 0, sees: false, through: 0, cos: 1, sin: 0 });

// Two rooms above a hall, apart from each other. Doorway A at (2, 3), front north; B at (6, 3), front south.
const ROOMS = parseMap('111111111\n1...1...1\n1S..1...1\n11.111.11\n1.......1\n1.......1\n111111111');
// A half turn about (4.5, 3.5) takes A's centre onto B's and A's normal (south) onto B's (north).
const A_TO_B: RigidTransform = { cos: -1, sin: 0, tx: 9, ty: 7 };
const A = 0;
const B = 1;
const ROOM_SPECS: PortalSpec[] = [
  { x: 2, y: 3, ny: 1, to: B, toDest: A_TO_B },
  { x: 6, y: 3, ny: -1, to: A, toDest: invert(A_TO_B) },
];
const ROOM_PORTALS = portalsOf(ROOMS, ROOM_SPECS);
const BEHIND_B = at(6.5, 2.5);

describe('hasPortalLineOfSight', () => {
  test('without portals it is hasLineOfSight', () => {
    expect(hasPortalLineOfSight(ROOMS, null, 2.5, 1.5, 2.5, 4.5)).toBe(true);
    expect(hasPortalLineOfSight(ROOMS, null, 2.5, 1.5, 6.5, 1.5)).toBe(false);
  });

  test('a segment crossing a plane front to back is no line of sight', () => {
    expect(hasPortalLineOfSight(ROOMS, ROOM_PORTALS, 2.5, 1.5, 2.5, 4.5)).toBe(false);
  });

  test('a segment crossing a plane back to front is an ordinary line of sight', () => {
    expect(hasPortalLineOfSight(ROOMS, ROOM_PORTALS, 2.5, 4.5, 2.5, 1.5)).toBe(true);
    expect(hasPortalLineOfSight(ROOMS, ROOM_PORTALS, 6.5, 1.5, 6.5, 4.5)).toBe(true);
  });

  test('a wall still blocks it', () => {
    expect(hasPortalLineOfSight(ROOMS, ROOM_PORTALS, 2.5, 1.5, 6.5, 1.5)).toBe(false);
  });
});

describe('apparentPosition', () => {
  test('without portals it is the real position with the plain line of sight', () => {
    const out = apparentPosition(ROOMS, null, at(2.5, 1.5), BEHIND_B, blank());
    expect(out).toEqual({ ...BEHIND_B, sees: hasLineOfSight(ROOMS, 2.5, 1.5, 6.5, 2.5), through: 0, cos: 1, sin: 0 });
    const inSight = apparentPosition(ROOMS, null, at(2.5, 4.5), at(6.5, 4.5), blank());
    expect(inSight).toEqual({ x: 6.5, y: 4.5, sees: true, through: 0, cos: 1, sin: 0 });
  });

  test('a target just behind B appears straight ahead through A, seen', () => {
    const out = apparentPosition(ROOMS, ROOM_PORTALS, at(2.5, 1.5), BEHIND_B, blank());
    expect(out.through).toBe(1);
    expect(out.sees).toBe(true);
    expect(out.x).toBeCloseTo(2.5);
    expect(out.y).toBeCloseTo(4.5);
  });

  test('the turn of the portal it is seen through takes its directions into the listener frame', () => {
    const through = apparentPosition(ROOMS, ROOM_PORTALS, at(2.5, 1.5), BEHIND_B, blank());
    expect(through.cos).toBeCloseTo(-1);
    expect(through.sin).toBeCloseTo(0);
    const straight = apparentPosition(ROOMS, null, at(2.5, 1.5), BEHIND_B, blank());
    expect([straight.cos, straight.sin]).toEqual([1, 0]);
  });

  test('from the back side of A there is no image: the real position, unseen', () => {
    const out = apparentPosition(ROOMS, ROOM_PORTALS, at(2.5, 4.5), BEHIND_B, blank());
    expect(out).toEqual({ ...BEHIND_B, sees: false, through: 0, cos: 1, sin: 0 });
  });

  test('an image off the line through the opening is never chosen, even with floor beside the doorway', () => {
    // Through A the target's image is (1.5, 5.5): straight down from the listener, past A's opening.
    const floorBesideDoors = parseMap('111111111\n1...1...1\n1S..1...1\n1..111..1\n1.......1\n1.......1\n111111111');
    const target = at(7.5, 1.5);
    const portals = portalsOf(floorBesideDoors, ROOM_SPECS);
    const out = apparentPosition(floorBesideDoors, portals, at(1.5, 1.5), target, blank());
    expect(out).toEqual({ ...target, sees: false, through: 0, cos: 1, sin: 0 });
  });

  test('a target in plain sight stays where it is', () => {
    const target = at(3.5, 1.5);
    const out = apparentPosition(ROOMS, ROOM_PORTALS, at(1.5, 1.5), target, blank());
    expect(out).toEqual({ ...target, sees: true, through: 0, cos: 1, sin: 0 });
  });

  test('out may be the target itself', () => {
    const target = { ...BEHIND_B, sees: false, through: 0 as const, cos: 1, sin: 0 };
    apparentPosition(ROOMS, ROOM_PORTALS, at(2.5, 1.5), target, target);
    expect(target.through).toBe(1);
    expect(target.y).toBeCloseTo(4.5);
  });
});

// Three closed corridors. A (1, 2) leads to B (3, 2); just past B's back stands C (3, 3), which leads to D (5, 2).
// Every front is north.
const CORRIDORS = parseMap('1111111\n1S1.1.1\n1.1.1.1\n1.1.1.1\n1.1.1.1\n1.1.1.1\n1111111');
const shift = (tx: number, ty: number): RigidTransform => ({ cos: 1, sin: 0, tx, ty });
const CHAIN = portalsOf(CORRIDORS, [
  { x: 1, y: 2, ny: 1, to: 1, toDest: shift(2, 0) },
  { x: 3, y: 2, ny: 1, to: 0, toDest: shift(-2, 0) },
  { x: 3, y: 3, ny: 1, to: 3, toDest: shift(2, -1) },
  { x: 5, y: 2, ny: 1, to: 2, toDest: shift(-2, 1) },
]);

// Two closed corridors. A (1, 2) leads to B (3, 2), both fronts north; a pillar stands in B's corridor at (3, 4).
const PILLAR = parseMap('11111\n1S1.1\n1.1.1\n1.1.1\n1.111\n1.1.1\n11111');
const PILLAR_PORTALS = portalsOf(PILLAR, [
  { x: 1, y: 2, ny: 1, to: 1, toDest: shift(2, 0) },
  { x: 3, y: 2, ny: 1, to: 0, toDest: shift(-2, 0) },
]);

// One open room. A (1, 2), front north, leads to B (5, 3), front south; a pillar at (5, 2) stands just behind B.
const OPEN = parseMap('1111111\n1S....1\n1....11\n1.....1\n1111111');
const OPEN_PORTALS = portalsOf(OPEN, [
  { x: 1, y: 2, ny: 1, to: 1, toDest: { cos: -1, sin: 0, tx: 7, ty: 6 } },
  { x: 5, y: 3, ny: -1, to: 0, toDest: { cos: -1, sin: 0, tx: 7, ty: 6 } },
]);

// Two long corridors. A (1, 2), front north, leads to B (3, 8) at the far end of the other, front south.
const LONG_WAY = parseMap(`11111\n1S1.1\n${'1.1.1\n'.repeat(7)}11111`);
const LONG_WAY_PORTALS = portalsOf(LONG_WAY, [
  { x: 1, y: 2, ny: 1, to: 1, toDest: { cos: -1, sin: 0, tx: 5, ty: 11 } },
  { x: 3, y: 8, ny: -1, to: 0, toDest: { cos: -1, sin: 0, tx: 5, ty: 11 } },
]);

describe('apparentPosition, seen and unseen', () => {
  test('an occluded image through a portal beats a farther, unseen real position', () => {
    const out = apparentPosition(PILLAR, PILLAR_PORTALS, at(1.5, 1.5), at(3.5, 5.5), blank());
    expect(out.through).toBe(1);
    expect(out.sees).toBe(false);
    expect(out.x).toBeCloseTo(1.5);
    expect(out.y).toBeCloseTo(5.5);
  });

  test('a seen real position beats a nearer, unseen image', () => {
    // Through A the target is 3 tiles away, but the pillar hides it; straight along the row it is 4 tiles, in sight.
    const target = at(5.5, 1.5);
    const out = apparentPosition(OPEN, OPEN_PORTALS, at(1.5, 1.5), target, blank());
    expect(out).toEqual({ ...target, sees: true, through: 0, cos: 1, sin: 0 });
  });

  test('a farther, seen image beats a nearer, unseen real position', () => {
    // The target is 2 tiles away through the wall, and 8 tiles away through A and up B's corridor.
    const out = apparentPosition(LONG_WAY, LONG_WAY_PORTALS, at(1.5, 1.5), at(3.5, 1.5), blank());
    expect(out.through).toBe(1);
    expect(out.sees).toBe(true);
    expect(out.x).toBeCloseTo(1.5);
    expect(out.y).toBeCloseTo(9.5);
  });
});

describe('apparentPosition through two portals', () => {
  const listener = at(1.5, 1.5);
  const behindD = at(5.5, 4.5);

  test('a target behind D appears through A then C', () => {
    const out = apparentPosition(CORRIDORS, CHAIN, listener, behindD, blank());
    expect(out.through).toBe(2);
    expect(out.sees).toBe(true);
    expect(out.x).toBeCloseTo(1.5);
    expect(out.y).toBeCloseTo(5.5);
    expect(out.cos).toBeCloseTo(1);
    expect(out.sin).toBeCloseTo(0);
  });

  test('with maxDepth 1 it is the real position', () => {
    const out = apparentPosition(CORRIDORS, CHAIN, listener, behindD, blank(), 1);
    expect(out).toEqual({ ...behindD, sees: false, through: 0, cos: 1, sin: 0 });
  });
});

describe('imagePosition', () => {
  test('never the straight position: a target in plain sight is the nearer image through A, unseen', () => {
    const target = at(5.5, 1.5);
    expect(apparentPosition(OPEN, OPEN_PORTALS, at(1.5, 1.5), target, blank()).through).toBe(0);
    const out = imagePosition(OPEN, OPEN_PORTALS, at(1.5, 1.5), target, blank());
    expect(out.through).toBe(1);
    expect(out.sees).toBe(false);
    expect(out.x).toBeCloseTo(1.5);
    expect(out.y).toBeCloseTo(4.5);
  });

  test('with no chain through a doorway, through is 0, unseen, at the target', () => {
    // The half turn between the doorways is about the wall between them, so a line to the own image never opens.
    const { map, portals } = twoDoorways();
    const eye = at(2.5, 2.5);
    expect(imagePosition(map, portals, eye, eye, blank())).toEqual({ ...eye, sees: false, through: 0, cos: 1, sin: 0 });
  });

  test('an image two portals deep is found, and with maxDepth 1 only an unseen one through a single portal', () => {
    const behindD = at(5.5, 4.5);
    const out = imagePosition(CORRIDORS, CHAIN, at(1.5, 1.5), behindD, blank());
    expect(out.through).toBe(2);
    expect(out.sees).toBe(true);
    expect(out.x).toBeCloseTo(1.5);
    expect(out.y).toBeCloseTo(5.5);
    const shallow = imagePosition(CORRIDORS, CHAIN, at(1.5, 1.5), behindD, blank(), 1);
    expect(shallow).toMatchObject({ through: 1, sees: false });
  });
});

// One long corridor: A (1, 18), front north, leads to B (3, 18) in a closed corridor beside it.
const LONG = parseMap(`111111\n1S1.11\n${'1.1.11\n'.repeat(21)}111111`);
const LONG_PORTALS = portalsOf(LONG, [
  { x: 1, y: 18, ny: 1, to: 1, toDest: shift(2, 0) },
  { x: 3, y: 18, ny: 1, to: 0, toDest: shift(-2, 0) },
]);

describe('apparentPosition beyond the near range', () => {
  const behindB = at(3.5, 19.5);

  test('a portal 15 tiles away is tried', () => {
    const out = apparentPosition(LONG, LONG_PORTALS, at(1.5, 3.5), behindB, blank());
    expect(out.through).toBe(1);
  });

  test('a portal 17 tiles away is never tried', () => {
    const out = apparentPosition(LONG, LONG_PORTALS, at(1.5, 1.5), behindB, blank());
    expect(out).toEqual({ ...behindB, sees: false, through: 0, cos: 1, sin: 0 });
  });
});

describe('isNear', () => {
  const map = parseMap(LEVEL1);
  const portals = wirePortals(map, 'AAAAAAAAAAAAAAAAAAAAAA');
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

  test('within range in a straight line is near, even when the image seen is farther', () => {
    const eye = at(39.5, 4.5);
    const target = at(34.5, 14.5);
    const seen = apparentPosition(map, portals, eye, target, blank());
    expect(distance(eye, seen)).toBeGreaterThan(NEAR_TILES);

    expect(isNear(portals, eye, target)).toBe(true);
  });

  test('far on the map but just past the other doorway is near with portals, far without', () => {
    const pair = portals.list
      .map((portal) => ({ portal, other: portals.list.at(portal.to) }))
      .find(({ portal, other }) => other && Math.hypot(portal.cx - other.cx, portal.cy - other.cy) > NEAR_TILES + 4);
    if (!pair?.other) {
      throw new Error('level1 has no pair of doorways far apart');
    }
    const { portal, other } = pair;
    const eye = at(portal.cx - portal.nx, portal.cy - portal.ny);
    const target = at(other.cx + other.nx, other.cy + other.ny);

    expect(isNear(portals, eye, target)).toBe(true);
    expect(isNear(null, eye, target)).toBe(false);
  });

  test('the range can be narrowed', () => {
    expect(isNear(null, at(0, 0), at(NEAR_TILES - 1, 0), NEAR_TILES - 1)).toBe(true);
    expect(isNear(null, at(0, 0), at(NEAR_TILES - 0.99, 0), NEAR_TILES - 1)).toBe(false);
  });
});

describe('hasLineOfSightThrough', () => {
  const { map, portals } = twoDoorways();

  test("sees a point behind A through A, from A's front", () => {
    // The copy of a lamp at (4.5, 1.5), north of B: (2.5, 5.5).
    expect(hasLineOfSightThrough(map, portals, 0, 2.5, 1.5, 2.5, 5.5)).toBe(true);
  });

  test("is false from A's back side, where the segment never crosses A front to back", () => {
    expect(hasLineOfSightThrough(map, portals, 0, 2.5, 4.5, 2.5, 5.5)).toBe(false);
  });

  test('is false for the wrong portal', () => {
    expect(hasLineOfSightThrough(map, portals, 1, 2.5, 1.5, 2.5, 5.5)).toBe(false);
  });

  test("is false when the segment meets A's plane outside its opening", () => {
    expect(hasLineOfSightThrough(map, portals, 0, 1.5, 1.5, 1.5, 5.5)).toBe(false);
  });
});
