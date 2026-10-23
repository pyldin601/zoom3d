// Voxel objects' shadows (voxel shadows spec §3.2): how much of each lamp the floor sees past an object, from the
// object's top-down height field, sampled across the lamp's disc so the edges and the tip are soft. Allocation-free.
import { LAMP_RADIUS, type Light } from './lighting';
import type { VoxelInstance, VoxelModel } from './voxels';

/**
 * Points on the lamp's disc (u, v pairs, tiles): the centre, 4 at half its radius, 8 on its rim. Across the whole disc,
 * not just the line across the sight line as the walls' seenShare: a low object's far tip is softened by the lamp's
 * extent along the sight line too.
 */
const DISC = (() => {
  const points = [0, 0];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    points.push(Math.cos(a) * LAMP_RADIUS * 0.5, Math.sin(a) * LAMP_RADIUS * 0.5);
  }
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    points.push(Math.cos(a) * LAMP_RADIUS, Math.sin(a) * LAMP_RADIUS);
  }
  return Float64Array.from(points);
})();
const DISC_POINTS = DISC.length / 2;

/** Half the diagonal of a model's footprint, in tiles: no part of it lies farther from its centre. */
export function footprintRadius(model: VoxelModel): number {
  return (Math.sqrt(model.sizeX * model.sizeX + model.sizeY * model.sizeY) * model.voxel) / 2;
}

/**
 * The farthest any of object `v`'s shadow from lamp `l` lies from its centre, in tiles: its footprint, plus how far its
 * top throws a shadow past its far edge. Capped at the lamp's reach past the footprint, where the lamp lights nothing.
 */
export function shadowReach(v: VoxelInstance, l: Light): number {
  const r = footprintRadius(v.model);
  const h = v.model.height;
  const d = Math.sqrt((v.x - l.x) * (v.x - l.x) + (v.y - l.y) * (v.y - l.y));
  return Math.min(r + ((d + r) * h) / (l.z - h), l.radius + r);
}

/** How much of lamp `l`'s disc the floor point (px, py) sees past object `v`, 0..1. */
export function objectSeenShare(v: VoxelInstance, l: Light, px: number, py: number): number {
  const ox = px - v.x;
  const oy = py - v.y;
  const r = footprintRadius(v.model);
  const reach = shadowReach(v, l);
  const onLampSide = ox * (v.x - l.x) + oy * (v.y - l.y) < -r * Math.sqrt((v.x - l.x) ** 2 + (v.y - l.y) ** 2);
  if (ox * ox + oy * oy > reach * reach || onLampSide) {
    return 1;
  }
  let seen = 0;
  for (let k = 0; k < DISC_POINTS; k++) {
    if (!blocked(v, px, py, l.x + (DISC[k * 2] as number), l.y + (DISC[k * 2 + 1] as number), l.z)) {
      seen++;
    }
  }
  return seen / DISC_POINTS;
}

/**
 * Whether the sight line from the floor at (px, py) up to (sx, sy, sz) passes under the top of one of `v`'s voxel
 * columns. It rises as it goes, so in each column it crosses it is lowest where it enters: walked column by column
 * through the model's grid (Amanatides–Woo), only while it is still below the model's height.
 */
function blocked(v: VoxelInstance, px: number, py: number, sx: number, sy: number, sz: number): boolean {
  const { voxel, sizeX, sizeY, tops, height } = v.model;
  const cos = Math.cos(v.angle);
  const sin = Math.sin(v.angle);
  // Into the model's grid: relative to its centre, turned by −angle, in voxels, with columns from 0.
  const ax = px - v.x;
  const ay = py - v.y;
  const bx = sx - v.x;
  const by = sy - v.y;
  const x0 = (ax * cos + ay * sin) / voxel + sizeX / 2;
  const y0 = (-ax * sin + ay * cos) / voxel + sizeY / 2;
  const dx = (bx * cos + by * sin) / voxel + sizeX / 2 - x0;
  const dy = (-bx * sin + by * cos) / voxel + sizeY / 2 - y0;
  // The line's height is sz · t; past `last` it is over every column.
  let first = 0;
  let last = height / sz;
  // Clipped to the grid's box, x then y. Written out: a loop over [start, step, size] tuples allocates per call.
  if (dx === 0) {
    if (x0 < 0 || x0 >= sizeX) {
      return false;
    }
  } else {
    first = Math.max(first, ((dx > 0 ? 0 : sizeX) - x0) / dx);
    last = Math.min(last, ((dx > 0 ? sizeX : 0) - x0) / dx);
  }
  if (dy === 0) {
    if (y0 < 0 || y0 >= sizeY) {
      return false;
    }
  } else {
    first = Math.max(first, ((dy > 0 ? 0 : sizeY) - y0) / dy);
    last = Math.min(last, ((dy > 0 ? sizeY : 0) - y0) / dy);
  }
  if (first > last) {
    return false;
  }
  let cx = Math.min(sizeX - 1, Math.max(0, Math.floor(x0 + dx * first)));
  let cy = Math.min(sizeY - 1, Math.max(0, Math.floor(y0 + dy * first)));
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const perX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const perY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  let nextX = dx === 0 ? Number.POSITIVE_INFINITY : ((dx > 0 ? cx + 1 : cx) - x0) / dx;
  let nextY = dy === 0 ? Number.POSITIVE_INFINITY : ((dy > 0 ? cy + 1 : cy) - y0) / dy;
  let t = first;
  while (t <= last && cx >= 0 && cy >= 0 && cx < sizeX && cy < sizeY) {
    if (sz * t < (tops[cy * sizeX + cx] as number)) {
      return true;
    }
    if (nextX < nextY) {
      t = nextX;
      nextX += perX;
      cx += stepX;
    } else {
      t = nextY;
      nextY += perY;
      cy += stepY;
    }
  }
  return false;
}
