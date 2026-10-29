// Shared by the renderer's tests of things seen through portals: the shared package's two-doorway hall, which it
// doesn't export.

import { type GameMap, invert, type Portal, type Portals, parseMap, type RigidTransform } from '@zoom3d/shared';

/**
 * A 7×7 hall with doorway A at (2, 3) (front north, back south) and doorway B at (4, 3) (front south, back north). A
 * half turn about the middle of the wall between them takes A's centre onto B's, so walking south through A comes out
 * of B walking north.
 */
export function portalHall(): { map: GameMap; portals: Portals } {
  const map = parseMap(['1111111', '1.....1', '1..S..1', '11.1.11', '1.....1', '1.....1', '1111111'].join('\n'));
  const atoB: RigidTransform = { cos: -1, sin: 0, tx: 7, ty: 7 };
  const portalAt = (x: number, to: number, ny: number): Portal => ({
    door: { x, y: 3, axis: 'ns' },
    cx: x + 0.5,
    cy: 3.5,
    nx: 0,
    ny,
    to,
    toDest: atoB,
    fromDest: invert(atoB),
  });
  const byTile = new Int32Array(map.width * map.height).fill(-1);
  byTile[3 * map.width + 2] = 0;
  byTile[3 * map.width + 4] = 1;
  return { map, portals: { map, list: [portalAt(2, 1, 1), portalAt(4, 0, -1)], byTile } };
}
