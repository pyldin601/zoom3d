// Portals: every doorway of a map gets a front and a destination doorway, both fixed by the room id. Pure.

import type { GameMap } from '../map/map';
import { seeded } from '../random';
import { type Doorway, findDoorways } from './doorways';
import { invert, type RigidTransform } from './transform';

export interface Portal {
  door: Doorway;
  /** Plane centre: the tile centre. */
  cx: number;
  cy: number;
  /** Unit normal, front to back. */
  nx: number;
  ny: number;
  /** Index of the destination portal. */
  to: number;
  /** This doorway's space into the destination's. */
  toDest: RigidTransform;
  fromDest: RigidTransform;
}

export interface Portals {
  map: GameMap;
  list: Portal[];
  /** Tile index to portal index, -1 where the tile is no doorway. */
  byTile: Int32Array;
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a, 32 bit. */
export function roomSeed(roomId: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < roomId.length; i++) {
    hash = Math.imul(hash ^ roomId.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return hash;
}

/** A single cycle over 0..count-1, so nothing maps to itself. */
function sattoloCycle(count: number, rng: () => number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * i);
    swap(order, i, j);
  }
  return order;
}

function swap(items: number[], i: number, j: number): void {
  const first = items.at(i);
  const second = items.at(j);
  if (first !== undefined && second !== undefined) {
    items[i] = second;
    items[j] = first;
  }
}

function normalOf(door: Doorway, rng: () => number): { nx: number; ny: number } {
  const sign = rng() < 0.5 ? -1 : 1;
  return door.axis === 'ns' ? { nx: 0, ny: sign } : { nx: sign, ny: 0 };
}

/** Rotates the source normal onto the destination normal; the integer normals give exact cos and sin. */
function transformBetween(from: Portal, to: Portal): RigidTransform {
  const cos = from.nx * to.nx + from.ny * to.ny;
  const sin = from.nx * to.ny - from.ny * to.nx;
  return {
    cos,
    sin,
    tx: to.cx - (cos * from.cx - sin * from.cy),
    ty: to.cy - (sin * from.cx + cos * from.cy),
  };
}

const IDENTITY: RigidTransform = { cos: 1, sin: 0, tx: 0, ty: 0 };
const MIN_DOORWAYS_TO_WIRE = 2;

export function wirePortals(map: GameMap, roomId: string): Portals {
  const byTile = new Int32Array(map.width * map.height).fill(-1);
  const doors = findDoorways(map);
  if (doors.length < MIN_DOORWAYS_TO_WIRE) {
    return { map, list: [], byTile };
  }
  const rng = seeded(roomSeed(roomId));
  const normals = doors.map((door) => normalOf(door, rng));
  const destinations = sattoloCycle(doors.length, rng);
  const list: Portal[] = doors.map((door, i) => ({
    door,
    cx: door.x + 0.5,
    cy: door.y + 0.5,
    ...(normals.at(i) ?? { nx: 0, ny: 1 }),
    to: destinations.at(i) ?? i,
    toDest: IDENTITY,
    fromDest: IDENTITY,
  }));
  for (const portal of list) {
    const destination = list.at(portal.to);
    if (destination !== undefined) {
      portal.toDest = transformBetween(portal, destination);
      portal.fromDest = invert(portal.toDest);
    }
  }
  for (const [i, portal] of list.entries()) {
    byTile[portal.door.y * map.width + portal.door.x] = i;
  }
  return { map, list, byTile };
}
