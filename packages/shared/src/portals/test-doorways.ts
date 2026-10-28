// Shared by the tests of things that go through portals: two doorways in the wall row y = 3.

import { type GameMap, parseMap } from '../map/map';
import { invert, type RigidTransform } from './transform';
import type { Portal, Portals } from './wiring';

/**
 * A hall with doorway A at x = 2 (front north, back south) and doorway B at x = `bx` (front south, back north). A
 * half turn about the middle of the wall between them takes A's centre onto B's, so walking south through A comes
 * out of B walking north.
 */
export function twoDoorways(bx = 4): { map: GameMap; portals: Portals; atoB: RigidTransform } {
  const width = bx + 3;
  const solid = '1'.repeat(width);
  const open = `1${'.'.repeat(width - 2)}1`;
  const wallRow = [...solid].map((c, x) => (x === 2 || x === bx ? '.' : c)).join('');
  const spawnRow = `1..S${'.'.repeat(width - 5)}1`;
  const map = parseMap([solid, open, spawnRow, wallRow, open, open, solid].join('\n'));
  const atoB: RigidTransform = { cos: -1, sin: 0, tx: bx + 3, ty: 7 };
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
  const byTile = new Int32Array(width * map.height).fill(-1);
  byTile[3 * width + 2] = 0;
  byTile[3 * width + bx] = 1;
  return { map, portals: { map, list: [portalAt(2, 1, 1), portalAt(bx, 0, -1)], byTile }, atoB };
}
