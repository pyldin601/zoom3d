// A ray for the portal renderer: castRay's grid walk, but a doorway seen from its front is a window and stops it. Pure.

import { createRayHit, type RayHit } from '../geometry/raycast';
import { type GameMap, tileAt } from '../map/map';
import type { Portals } from './wiring';

export interface PortalRayHit extends RayHit {
  /** Index of the portal whose plane stopped the ray, or −1 when it hit a wall. */
  portal: number;
}

export function createPortalRayHit(): PortalRayHit {
  return { ...createRayHit(), portal: -1 };
}

const MAX_STEPS = 256;

/**
 * castRay from the eye, walking from nearDepth along (dx, dy) on; distances are still measured from the eye.
 * Stops at a doorway plane crossed front to back beyond nearDepth.
 */
export function castPortalRay(
  map: GameMap,
  p: Portals,
  ex: number,
  ey: number,
  dx: number,
  dy: number,
  nearDepth: number,
  out: PortalRayHit
): PortalRayHit {
  const px = ex + nearDepth * dx;
  const py = ey + nearDepth * dy;
  let mapX = Math.floor(px);
  let mapY = Math.floor(py);
  const deltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const deltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  const stepX = dx < 0 ? -1 : 1;
  const stepY = dy < 0 ? -1 : 1;
  let sideX = dx < 0 ? (px - mapX) * deltaX : (mapX + 1 - px) * deltaX;
  let sideY = dy < 0 ? (py - mapY) * deltaY : (mapY + 1 - py) * deltaY;
  let side: 0 | 1 = 0;

  // The start tile counts too: the eye or the virtual eye may stand in a doorway with the plane still ahead.
  if (stopsAtPlane(map, p, mapX, mapY, ex, ey, dx, dy, nearDepth, out)) {
    return out;
  }
  for (let i = 0; i < MAX_STEPS; i++) {
    if (sideX < sideY) {
      sideX += deltaX;
      mapX += stepX;
      side = 0;
    } else {
      sideY += deltaY;
      mapY += stepY;
      side = 1;
    }
    const tile = tileAt(map, mapX, mapY);
    if (tile !== 0) {
      const distance = (side === 0 ? sideX - deltaX : sideY - deltaY) + nearDepth;
      const along = side === 0 ? ey + distance * dy : ex + distance * dx;
      out.distance = distance;
      out.mapX = mapX;
      out.mapY = mapY;
      out.side = side;
      out.wallX = along - Math.floor(along);
      out.tile = tile;
      out.portal = -1;
      return out;
    }
    if (stopsAtPlane(map, p, mapX, mapY, ex, ey, dx, dy, nearDepth, out)) {
      return out;
    }
  }
  out.distance = Number.POSITIVE_INFINITY;
  out.mapX = mapX;
  out.mapY = mapY;
  out.side = side;
  out.wallX = 0;
  out.tile = 0;
  out.portal = -1;
  return out;
}

/** Fills `out` and returns true when the tile is a doorway whose plane the ray crosses front to back inside it. */
function stopsAtPlane(
  map: GameMap,
  p: Portals,
  tileX: number,
  tileY: number,
  ex: number,
  ey: number,
  dx: number,
  dy: number,
  nearDepth: number,
  out: PortalRayHit
): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height) {
    return false;
  }
  const index = p.byTile[tileY * map.width + tileX] ?? -1;
  const portal = index < 0 ? undefined : p.list.at(index);
  if (portal === undefined || dx * portal.nx + dy * portal.ny <= 0) {
    return false;
  }
  const acrossNorthSouth = portal.door.axis === 'ns';
  const depth = acrossNorthSouth ? (portal.cy - ey) / dy : (portal.cx - ex) / dx;
  if (!(depth > nearDepth)) {
    return false;
  }
  const along = acrossNorthSouth ? ex + depth * dx : ey + depth * dy;
  const planeStart = acrossNorthSouth ? portal.door.x : portal.door.y;
  if (along < planeStart || along > planeStart + 1) {
    return false;
  }
  out.distance = depth;
  out.mapX = tileX;
  out.mapY = tileY;
  out.side = acrossNorthSouth ? 1 : 0;
  out.wallX = along - Math.floor(along);
  out.tile = 0;
  out.portal = index;
  return true;
}
