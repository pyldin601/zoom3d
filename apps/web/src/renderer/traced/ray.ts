// The one ray walk everything else is built on. Walls are full height and the floor and ceiling flat (z 0 and 1), so a
// 3D ray is blocked exactly where its 2D path across the grid enters a wall cell: a grid walk with a height bound.
// Allocation-free: results go into `out`, since the bake and the frame call it millions of times.
import { tileAt } from '@zoom3d/shared';
import { FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_WEST, NO_FACE, type TracedWorld } from './world';

export const HIT_NONE = 0;
export const HIT_WALL = 1;
export const HIT_FLOOR = 2;
export const HIT_CEILING = 3;

/** From (x, y, z) in tiles, along (dx, dy, dz), which need not be a unit vector. */
export interface Ray3 {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface RayHit3 {
  /** HIT_*. On HIT_NONE nothing else is meaningful. */
  kind: number;
  /** Along the ray, in units of its direction vector. */
  t: number;
  x: number;
  y: number;
  z: number;
  /** HIT_WALL only: the wall cell's tile id, the side the ray entered it through (FACE_*) and that face's index. */
  tile: number;
  side: number;
  faceIndex: number;
  /** HIT_WALL only: where across the face, 0..1: y for west and east faces, x for north and south. */
  u: number;
}

export function createRay3(): Ray3 {
  return { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 };
}

export function createRayHit3(): RayHit3 {
  return { kind: HIT_NONE, t: 0, x: 0, y: 0, z: 0, tile: 0, side: FACE_WEST, faceIndex: NO_FACE, u: 0 };
}

/**
 * Follows the ray up to t = maxT and fills `out` with what it meets first. The ray starts in open space: the cell it
 * starts in is not tested. The face index is read by index, not with `.at()`, which made a shadow ray take 62 ns
 * against 47 ns.
 */
export function trace(world: TracedWorld, ray: Ray3, maxT: number, out: RayHit3): RayHit3 {
  const { x, y, z, dx, dy, dz } = ray;
  const tFloorOrCeiling = tToFloorOrCeiling(z, dz);
  const tEnd = Math.min(tFloorOrCeiling, maxT);
  let cellX = Math.floor(x);
  let cellY = Math.floor(y);
  const stepX = dx < 0 ? -1 : 1;
  const stepY = dy < 0 ? -1 : 1;
  const tPerCellX = Math.abs(1 / dx);
  const tPerCellY = Math.abs(1 / dy);
  // A ray that doesn't move along an axis never crosses its grid lines: infinite, never 0 × Infinity.
  let tNextX = dx === 0 ? Number.POSITIVE_INFINITY : (dx < 0 ? x - cellX : cellX + 1 - x) * tPerCellX;
  let tNextY = dy === 0 ? Number.POSITIVE_INFINITY : (dy < 0 ? y - cellY : cellY + 1 - y) * tPerCellY;
  for (;;) {
    const crossesX = tNextX < tNextY;
    const t = crossesX ? tNextX : tNextY;
    if (t >= tEnd) {
      break;
    }
    if (crossesX) {
      cellX += stepX;
      tNextX += tPerCellX;
    } else {
      cellY += stepY;
      tNextY += tPerCellY;
    }
    const tile = tileAt(world.map, cellX, cellY);
    if (tile !== 0) {
      const side = sideEntered(crossesX, stepX, stepY);
      const alongFace = crossesX ? y + dy * t : x + dx * t;
      out.kind = HIT_WALL;
      out.t = t;
      out.x = x + dx * t;
      out.y = y + dy * t;
      out.z = z + dz * t;
      out.tile = tile;
      out.side = side;
      out.faceIndex = world.faceIndex[(cellY * world.width + cellX) * 4 + side] ?? NO_FACE;
      out.u = alongFace - Math.floor(alongFace);
      return out;
    }
  }
  if (tFloorOrCeiling > maxT) {
    out.kind = HIT_NONE;
    return out;
  }
  return fillFloorOrCeilingHit(ray, tFloorOrCeiling, out);
}

const shadowRay = createRay3();
const shadowHit = createRayHit3();

/** Whether nothing stands between the 2D points a and b: a shadow ray (walls are full height, so z doesn't matter). */
export function clearBetween(world: TracedWorld, ax: number, ay: number, bx: number, by: number): boolean {
  shadowRay.x = ax;
  shadowRay.y = ay;
  shadowRay.z = 0.5;
  shadowRay.dx = bx - ax;
  shadowRay.dy = by - ay;
  shadowRay.dz = 0;
  // A hair short of b: with b on a wall's face, rounding must not let the walk enter that wall.
  return trace(world, shadowRay, 1 - 1e-9, shadowHit).kind === HIT_NONE;
}

/** The t at which a ray from height z, rising at dz per t, reaches the floor (z 0) or ceiling (z 1); Infinity if level. */
function tToFloorOrCeiling(z: number, dz: number): number {
  if (dz < 0) {
    return -z / dz;
  }
  return dz > 0 ? (1 - z) / dz : Number.POSITIVE_INFINITY;
}

function fillFloorOrCeilingHit(ray: Ray3, t: number, out: RayHit3): RayHit3 {
  const goesDown = ray.dz < 0;
  out.kind = goesDown ? HIT_FLOOR : HIT_CEILING;
  out.t = t;
  out.x = ray.x + ray.dx * t;
  out.y = ray.y + ray.dy * t;
  out.z = goesDown ? 0 : 1;
  return out;
}

/** The face of the wall cell a ray enters, given the grid line it crossed and the way it steps along each axis. */
function sideEntered(crossesX: boolean, stepX: number, stepY: number): number {
  if (crossesX) {
    return stepX > 0 ? FACE_WEST : FACE_EAST;
  }
  return stepY > 0 ? FACE_NORTH : FACE_SOUTH;
}
