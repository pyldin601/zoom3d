import { type Apparent, hasLineOfSight, invert, type Portal, type Portals, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import type { NameLabel } from '../renderer/labels';
import { createApparentWorld, placeOwnLabel } from './apparent-world';

// Two rooms above a hall. Doorway A at (2, 3), front north; B at (6, 3), front south.
const ROOMS = parseMap('111111111\n1...1...1\n1S..1...1\n11.111.11\n1.......1\n1.......1\n111111111');
const A_TO_B = { cos: -1, sin: 0, tx: 9, ty: 7 };

function wire(): Portals {
  const specs = [
    { x: 2, ny: 1, to: 1, toDest: A_TO_B },
    { x: 6, ny: -1, to: 0, toDest: invert(A_TO_B) },
  ];
  const list: Portal[] = specs.map(({ x, ny, to, toDest }) => ({
    door: { x, y: 3, axis: 'ns' },
    cx: x + 0.5,
    cy: 3.5,
    nx: 0,
    ny,
    to,
    toDest,
    fromDest: invert(toDest),
  }));
  const byTile = new Int32Array(ROOMS.width * ROOMS.height).fill(-1);
  for (const [i, portal] of list.entries()) {
    byTile[portal.door.y * ROOMS.width + portal.door.x] = i;
  }
  return { map: ROOMS, list, byTile };
}

const eye = { x: 2.5, y: 1.5 };
const things = [
  { id: 'near', x: 3.5, y: 1.5 },
  { id: 'behindB', x: 6.5, y: 2.5 },
  { id: 'walled', x: 6.5, y: 1.5 },
];

describe('createApparentWorld', () => {
  test('without portals everyone is where they are, seen as the plain line of sight says', () => {
    const world = createApparentWorld();
    const result = world.update(ROOMS, null, eye, things);
    for (const t of things) {
      const a = result.get(t.id) as Apparent;
      expect(a).toMatchObject({ x: t.x, y: t.y, through: 0, sees: hasLineOfSight(ROOMS, eye.x, eye.y, t.x, t.y) });
    }
  });

  test('someone beyond a doorway appears at the doorway, in sight', () => {
    const world = createApparentWorld();
    const a = world.update(ROOMS, wire(), eye, things).get('behindB') as Apparent;
    expect(a.through).toBe(1);
    expect(a.sees).toBe(true);
    expect(a.x).toBeCloseTo(2.5);
    expect(a.y).toBeCloseTo(4.5);
  });

  test('the same Apparent objects are reused, and ids that are gone are forgotten', () => {
    const world = createApparentWorld();
    const first = world.update(ROOMS, null, eye, things).get('near');
    const second = world.update(ROOMS, null, eye, things.slice(0, 1)).get('near');
    expect(second).toBe(first);
    const gone = world.update(ROOMS, null, eye, things.slice(0, 1));
    expect([...gone.keys()]).toEqual(['near']);
  });
});

// One room above a hall, with doorway C at (2, 3), front north, that leads back into itself turned round: walking
// south through it comes out of it walking north, so a window in it looks back at the room.
const LOOP = parseMap('11111\n1...1\n1.S.1\n11.11\n1...1\n1...1\n11111');
const TURN_ABOUT_C = { cos: -1, sin: 0, tx: 5, ty: 7 };

function loopBack(): Portals {
  const byTile = new Int32Array(LOOP.width * LOOP.height).fill(-1);
  byTile[3 * LOOP.width + 2] = 0;
  const c: Portal = {
    door: { x: 2, y: 3, axis: 'ns' },
    cx: 2.5,
    cy: 3.5,
    nx: 0,
    ny: 1,
    to: 0,
    toDest: TURN_ABOUT_C,
    fromDest: invert(TURN_ABOUT_C),
  };
  return { map: LOOP, list: [c], byTile };
}

const blankLabel = (): NameLabel => ({ shownX: 0, shownY: 0, name: '', mic: false });

describe('placeOwnLabel', () => {
  test("the own label sits at the own position's image through the portal that shows it", () => {
    const label = blankLabel();
    expect(placeOwnLabel(LOOP, loopBack(), { x: 2.5, y: 1.5 }, label)).toBe(true);
    expect(label.shownX).toBeCloseTo(2.5);
    expect(label.shownY).toBeCloseTo(5.5);
  });

  test('no own label with portals off', () => {
    expect(placeOwnLabel(LOOP, null, { x: 2.5, y: 1.5 }, blankLabel())).toBe(false);
  });

  test('no own label when no portal shows the own position', () => {
    // In the hall, behind the doorway's back.
    expect(placeOwnLabel(LOOP, loopBack(), { x: 2.5, y: 4.5 }, blankLabel())).toBe(false);
  });
});
