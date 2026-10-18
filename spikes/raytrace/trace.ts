// The one ray walk everything is built on. Walls are full height and the floor and ceiling flat (z 0 and 1), so a 3D
// ray is blocked exactly where its 2D path across the grid enters a wall cell: a grid walk plus a height check.
import { FACE_E, FACE_N, FACE_S, FACE_W, isSolid, type World } from './world';

export const MISS = 0;
export const WALL = 1;
export const FLOOR = 2;
export const CEILING = 3;

export interface Hit {
  kind: number;
  /** Along the ray, in units of its direction vector. */
  t: number;
  x: number;
  y: number;
  z: number;
  /** WALL only: the wall cell's tile id, its face (FACE_*), the face's lightmap index and where across it (0..1). */
  tile: number;
  face: number;
  faceIndex: number;
  u: number;
}

export function createHit(): Hit {
  return { kind: MISS, t: 0, x: 0, y: 0, z: 0, tile: 0, face: 0, faceIndex: -1, u: 0 };
}

/** Follows the ray from (ox, oy, oz) along (dx, dy, dz) up to t = maxT and fills `out` with what it hits first. */
export function trace(
  world: World,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  out: Hit
): Hit {
  const tPlane = dz < 0 ? -oz / dz : dz > 0 ? (1 - oz) / dz : Number.POSITIVE_INFINITY;
  const tEnd = Math.min(tPlane, maxT);
  let mapX = Math.floor(ox);
  let mapY = Math.floor(oy);
  const deltaX = Math.abs(1 / dx);
  const deltaY = Math.abs(1 / dy);
  const stepX = dx < 0 ? -1 : 1;
  const stepY = dy < 0 ? -1 : 1;
  let sideX = dx === 0 ? Number.POSITIVE_INFINITY : dx < 0 ? (ox - mapX) * deltaX : (mapX + 1 - ox) * deltaX;
  let sideY = dy === 0 ? Number.POSITIVE_INFINITY : dy < 0 ? (oy - mapY) * deltaY : (mapY + 1 - oy) * deltaY;
  for (;;) {
    const crossesX = sideX < sideY;
    const t = crossesX ? sideX : sideY;
    if (t >= tEnd) {
      break;
    }
    if (crossesX) {
      mapX += stepX;
      sideX += deltaX;
    } else {
      mapY += stepY;
      sideY += deltaY;
    }
    if (isSolid(world, mapX, mapY)) {
      out.kind = WALL;
      out.t = t;
      out.x = ox + dx * t;
      out.y = oy + dy * t;
      out.z = oz + dz * t;
      out.tile = world.map.tiles[mapY * world.w + mapX] ?? 1;
      out.face = crossesX ? (stepX > 0 ? FACE_W : FACE_E) : stepY > 0 ? FACE_N : FACE_S;
      out.faceIndex = world.faceIndex[(mapY * world.w + mapX) * 4 + out.face] ?? -1;
      const along = crossesX ? out.y : out.x;
      out.u = along - Math.floor(along);
      return out;
    }
  }
  if (tPlane > maxT) {
    out.kind = MISS;
    return out;
  }
  out.kind = dz < 0 ? FLOOR : CEILING;
  out.t = tPlane;
  out.x = ox + dx * tPlane;
  out.y = oy + dy * tPlane;
  out.z = dz < 0 ? 0 : 1;
  return out;
}

const shadowHit = createHit();

/** Whether nothing stands between 2D points a and b: a shadow ray (heights don't matter, walls are full height). */
export function clearBetween(world: World, ax: number, ay: number, bx: number, by: number): boolean {
  return trace(world, ax, ay, 0.5, bx - ax, by - ay, 0, 1 - 1e-9, shadowHit).kind === MISS;
}
