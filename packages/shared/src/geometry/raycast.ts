// Grid DDA ray casting (Lode Vandevenne style). Allocation-free: results go into `out`.
import { type GameMap, tileAt } from '../map/map';

export interface RayHit {
  /** Perpendicular distance along the ray direction (true distance when dir is unit length). */
  distance: number;
  mapX: number;
  mapY: number;
  /** 0: hit a vertical grid line (x-side), 1: horizontal grid line (y-side). */
  side: 0 | 1;
  /** Fractional hit position along the wall face, in [0, 1). */
  wallX: number;
  tile: number;
}

export function createRayHit(): RayHit {
  return { distance: 0, mapX: 0, mapY: 0, side: 0, wallX: 0, tile: 0 };
}

export function castRay(
  map: GameMap,
  px: number,
  py: number,
  dirX: number,
  dirY: number,
  out: RayHit,
  maxSteps = 256,
): RayHit {
  let mapX = Math.floor(px);
  let mapY = Math.floor(py);
  const deltaX = dirX === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dirX);
  const deltaY = dirY === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dirY);
  const stepX = dirX < 0 ? -1 : 1;
  const stepY = dirY < 0 ? -1 : 1;
  let sideX = dirX < 0 ? (px - mapX) * deltaX : (mapX + 1 - px) * deltaX;
  let sideY = dirY < 0 ? (py - mapY) * deltaY : (mapY + 1 - py) * deltaY;
  let side: 0 | 1 = 0;

  for (let i = 0; i < maxSteps; i++) {
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
      const distance = side === 0 ? sideX - deltaX : sideY - deltaY;
      const along = side === 0 ? py + distance * dirY : px + distance * dirX;
      out.distance = distance;
      out.mapX = mapX;
      out.mapY = mapY;
      out.side = side;
      out.wallX = along - Math.floor(along);
      out.tile = tile;
      return out;
    }
  }
  out.distance = Number.POSITIVE_INFINITY;
  out.mapX = mapX;
  out.mapY = mapY;
  out.side = side;
  out.wallX = 0;
  out.tile = 0;
  return out;
}
