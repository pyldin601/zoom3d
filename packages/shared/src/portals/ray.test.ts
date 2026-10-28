import { describe, expect, it } from 'vitest';
import { castRay, createRayHit } from '../geometry/raycast';
import { LEVEL1 } from '../map/level1';
import { parseMap } from '../map/map';
import { castPortalRay, createPortalRayHit } from './ray';
import { invert, type RigidTransform } from './transform';
import type { Portal, Portals } from './wiring';

// Two doorways in the wall row y = 3: A at x = 2 (front north, back south), B at x = 4 (front south, back north).
const MAP = parseMap('1111111\n1.....1\n1..S..1\n11.1.11\n1.....1\n1.....1\n1111111');
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

function noPortals(map: Portals['map']): Portals {
  return { map, list: [], byTile: new Int32Array(map.width * map.height).fill(-1) };
}

describe('castPortalRay', () => {
  it('equals castRay field for field when no doorway is on the way', () => {
    const level = parseMap(LEVEL1);
    const portals = noPortals(level);
    const expected = createRayHit();
    const actual = createPortalRayHit();
    let compared = 0;
    for (let y = 1; y < level.height - 1; y += 3) {
      for (let x = 1; x < level.width - 1; x += 3) {
        for (let k = 0; k < 40; k++) {
          const angle = (k / 40) * Math.PI * 2;
          const dx = Math.cos(angle);
          const dy = Math.sin(angle);
          castRay(level, x + 0.5, y + 0.5, dx, dy, expected);
          castPortalRay(level, portals, x + 0.5, y + 0.5, dx, dy, 0, actual);
          expect(actual).toEqual({ ...expected, portal: -1 });
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('stops at the plane of a doorway seen from its front', () => {
    const hit = castPortalRay(MAP, PORTALS, 2.5, 1.5, 0, 1, 0, createPortalRayHit());
    expect(hit.portal).toBe(A);
    expect(hit.distance).toBeCloseTo(2);
    expect(hit.mapX).toBe(2);
    expect(hit.mapY).toBe(3);
    expect(hit.side).toBe(1);
    expect(hit.tile).toBe(0);
    expect(hit.wallX).toBeCloseTo(0.5);
  });

  it('measures the depth of an oblique ray along the ray', () => {
    const hit = castPortalRay(MAP, PORTALS, 2.25, 1.5, 0.5, 2, 0, createPortalRayHit());
    expect(hit.portal).toBe(A);
    expect(hit.distance).toBeCloseTo(1);
    expect(hit.wallX).toBeCloseTo(0.75);
  });

  it('lets a ray through a doorway seen from its back', () => {
    const actual = castPortalRay(MAP, PORTALS, 2.5, 5.5, 0, -1, 0, createPortalRayHit());
    expect(actual).toEqual({ ...castRay(MAP, 2.5, 5.5, 0, -1, createRayHit()), portal: -1 });
  });

  it('lets an edge-on ray along the plane line pass', () => {
    const actual = castPortalRay(MAP, PORTALS, 2.5, 3.5, 1, 0, 0, createPortalRayHit());
    expect(actual).toEqual({ ...castRay(MAP, 2.5, 3.5, 1, 0, createRayHit()), portal: -1 });
  });

  it('ignores a plane nearer than nearDepth', () => {
    const hit = castPortalRay(MAP, PORTALS, 2.5, 1.5, 0, 1, 2.5, createPortalRayHit());
    expect(hit.portal).toBe(-1);
    expect(hit.distance).toBeCloseTo(4.5);
  });

  it('stops at a plane ahead when the start stands in the doorway tile', () => {
    const hit = castPortalRay(MAP, PORTALS, 2.5, 1.5, 0, 1, 1.75, createPortalRayHit());
    expect(hit.portal).toBe(A);
    expect(hit.distance).toBeCloseTo(2);
  });

  it('ignores a wall nearer than nearDepth and reports depth from the eye', () => {
    const rooms = parseMap('11111111\n1S.1...1\n1..1...1\n11111111');
    const hit = castPortalRay(rooms, noPortals(rooms), 1.5, 1.5, 1, 0, 3, createPortalRayHit());
    expect(hit.distance).toBeCloseTo(5.5);
    expect(hit.mapX).toBe(7);
    expect(hit.side).toBe(0);
    expect(hit.portal).toBe(-1);
  });

  describe('a window pass starting on a plane', () => {
    // Two doorways in one column, both facing north: a ray heading south meets A at depth 2, then B at depth 5.
    const column = parseMap('1111111\n1.....1\n1..S..1\n11.1111\n1.....1\n1.....1\n11.1111\n1.....1\n1111111');
    const doorAt = (y: number, to: number): Portal => ({
      ...portalAt(2, to, 1),
      door: { x: 2, y, axis: 'ns' },
      cy: y + 0.5,
    });
    const doors: Portals = {
      map: column,
      list: [doorAt(3, 1), doorAt(6, 0)],
      byTile: Int32Array.from({ length: column.width * column.height }, (_, tile) => {
        const tileX = tile % column.width;
        const tileY = Math.floor(tile / column.width);
        return tileX === 2 && tileY === 3 ? 0 : tileX === 2 && tileY === 6 ? 1 : -1;
      }),
    };
    const depthToA = 2;

    it.each([
      ['exact', depthToA],
      ['one ulp above', depthToA * (1 + Number.EPSILON)],
      ['one ulp below', depthToA * (1 - Number.EPSILON)],
    ])('passes the plane it starts on and stops at the next (%s)', (_, nearDepth) => {
      const hit = castPortalRay(column, doors, 2.5, 1.5, 0, 1, nearDepth, createPortalRayHit());
      expect(hit.portal).toBe(1);
      expect(hit.distance).toBeCloseTo(5);
    });
  });
});
