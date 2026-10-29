// Voxel objects' shadows (voxel shadows spec §3.2): how much of each lamp the floor sees past an object, from the
// object's top-down height field, sampled across the lamp's disc so the edges and the tip are soft. Allocation-free.
import { tileAt } from '@zoom3d/shared';
import {
  FLOOR_SUB,
  floorLampLight,
  LAMP_RADIUS,
  type Light,
  type Lighting,
  REFLECTION_LAMPS,
  seenShare,
} from './lighting';
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
 * top throws a shadow past its far edge. Capped where the shadow's cut of the lamp's reflection has faded out
 * (REFLECTION_CUT_REACH), past the footprint.
 */
export function shadowReach(v: VoxelInstance, l: Light): number {
  const r = footprintRadius(v.model);
  const h = v.model.height;
  const d = Math.sqrt((v.x - l.x) * (v.x - l.x) + (v.y - l.y) * (v.y - l.y));
  return Math.min(r + ((d + r) * h) / (l.z - h), l.radius * REFLECTION_CUT_REACH + r);
}

/** How much of lamp `l`'s disc the floor point (px, py) sees past object `v`, 0..1. */
export function objectSeenShare(v: VoxelInstance, l: Light, px: number, py: number): number {
  const ox = px - v.x;
  const oy = py - v.y;
  const r = footprintRadius(v.model);
  const reach = shadowReach(v, l);
  const lampDistance = Math.sqrt((v.x - l.x) ** 2 + (v.y - l.y) ** 2);
  // Nearer the lamp than its disc's edge, sight lines to the disc's far side cross the object from either side.
  const onLampSide = lampDistance > r + LAMP_RADIUS && ox * (v.x - l.x) + oy * (v.y - l.y) < -r * lampDistance;
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

/** The per-frame copies of a Lighting's floor tables that shadeFloor darkens. */
export interface PatchedFloor {
  floor: Uint32Array;
  floorLampSeen: Uint8Array;
  /** Marks a cell as patched this frame, so it's put back next frame. */
  touch(cell: number): void;
}

/** Under half a step of brightness (×255 scale) a shadow changes nothing, so the cell isn't tested. */
const UNSEEN_LOSS = 0.5;
/**
 * A lamp's floor light ends at its radius, but its reflection on the floor never does (lighting.ts lampLit). Past the
 * radius a shadow still cuts the reflection, fading out by this many radii from the lamp: cut off sharply there, the
 * reflection came back along a hard row.
 */
const REFLECTION_CUT_REACH = 1.5;
/** How much of a lamp's light an object's shadow takes away: 1 is all of it. */
export const OBJECT_SHADOW_DARKNESS = 1;

/** Per floor cell, the lamp pass that last shaded it: each cell is shaded once per lamp, however many objects. */
let shadedIn = new Uint32Array(0);
let pass = 0;

/**
 * Darkens the floor cells in each object's shadows from each lamp (voxel shadows spec §3.2): a cell loses the share of
 * that lamp's light the objects hide, and its listed seen share of the lamp (for reflections) shrinks by it. `albedo`
 * is the floor's colour the Lighting was baked with; only cells in shadows `inView` are worked out.
 */
export function shadeFloor(
  lm: Lighting,
  objects: readonly VoxelInstance[],
  albedo: number,
  tables: PatchedFloor,
  inView: (x: number, y: number, reach: number) => boolean
): void {
  if (shadedIn.length !== lm.floor.length) {
    shadedIn = new Uint32Array(lm.floor.length);
    pass = 0;
  }
  for (let li = 0; li < lm.lights.length; li++) {
    const l = lm.lights[li] as Light;
    pass++;
    for (const v of objects) {
      if (casts(lm, v, l)) {
        shadeBox(lm, objects, li, l, v, albedo, tables, inView);
      }
    }
  }
}

/** Whether object `v` casts a shadow from lamp `l` that shows. */
const casts = (lm: Lighting, v: VoxelInstance, l: Light) => reaches(v, l) && !behindPortalOf(lm, v, l);

/** Whether object `v`'s shadow from lamp `l` shows: it stands within the reach of the lamp's light or its cut reflection. */
const reaches = (v: VoxelInstance, l: Light) =>
  (v.x - l.x) ** 2 + (v.y - l.y) ** 2 < (l.radius * REFLECTION_CUT_REACH) ** 2;

/**
 * Whether `l` is a copy and object `v` stands behind the plane of the portal it is seen through. The copy sits behind
 * that plane too, but only the floor in front sees it, and from there the window shows the destination, not `v`.
 */
function behindPortalOf(lm: Lighting, v: VoxelInstance, l: Light): boolean {
  const portal = l.through === undefined ? undefined : lm.portals?.list.at(l.through);
  return portal !== undefined && (v.x - portal.cx) * portal.nx + (v.y - portal.cy) * portal.ny >= 0;
}

/**
 * How much of a shadow's cut of lamp `l`'s reflection shows `distance` tiles from it: all of it within the lamp's
 * radius, easing out to none at REFLECTION_CUT_REACH radii.
 */
function reflectionCut(l: Light, distance: number): number {
  const t = Math.min(1, Math.max(0, (distance - l.radius) / (l.radius * (REFLECTION_CUT_REACH - 1))));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Shades the cells of the box round object `v`'s shadow from lamp `l` (index `li`) that this lamp's pass hasn't yet:
 * the box covers its footprint and its tip, where the shadow is widest (spread by the lamp's disc).
 */
function shadeBox(
  lm: Lighting,
  objects: readonly VoxelInstance[],
  li: number,
  l: Light,
  v: VoxelInstance,
  albedo: number,
  tables: PatchedFloor,
  inView: (x: number, y: number, reach: number) => boolean
): void {
  const r = footprintRadius(v.model);
  const h = v.model.height;
  const reach = shadowReach(v, l);
  const awayX = v.x - l.x;
  const awayY = v.y - l.y;
  const away = Math.sqrt(awayX * awayX + awayY * awayY);
  const tipX = away === 0 ? v.x : v.x + (awayX / away) * (reach - r);
  const tipY = away === 0 ? v.y : v.y + (awayY / away) * (reach - r);
  const tipRadius = ((r + LAMP_RADIUS) * l.z) / (l.z - h);
  const left = Math.min(v.x - r, tipX - tipRadius);
  const right = Math.max(v.x + r, tipX + tipRadius);
  const top = Math.min(v.y - r, tipY - tipRadius);
  const bottom = Math.max(v.y + r, tipY + tipRadius);
  const halfDiagonal = Math.sqrt((right - left) ** 2 + (bottom - top) ** 2) / 2;
  if (!inView((left + right) / 2, (top + bottom) / 2, halfDiagonal)) {
    return;
  }
  const { stride, rows } = lm;
  const brightest = Math.max(albedo & 0xff, (albedo >>> 8) & 0xff, (albedo >>> 16) & 0xff) * Math.max(l.r, l.g, l.b);
  for (let cy = Math.max(0, Math.floor(top * FLOOR_SUB)); cy <= Math.min(rows - 1, bottom * FLOOR_SUB); cy++) {
    for (let cx = Math.max(0, Math.floor(left * FLOOR_SUB)); cx <= Math.min(stride - 1, right * FLOOR_SUB); cx++) {
      const cell = cy * stride + cx;
      if (shadedIn[cell] === pass) {
        continue;
      }
      shadedIn[cell] = pass;
      const x = (cx + 0.5) / FLOOR_SUB;
      const y = (cy + 0.5) / FLOOR_SUB;
      const lamp = floorLampLight(l, x, y);
      const slot = listedSlot(lm, cell, li);
      const cut = slot < 0 ? 0 : reflectionCut(l, Math.sqrt((x - l.x) ** 2 + (y - l.y) ** 2));
      if ((lamp * brightest < UNSEEN_LOSS && cut === 0) || tileAt(lm.map, Math.floor(x), Math.floor(y)) !== 0) {
        continue;
      }
      const objectSeen = seenPastObjects(lm, objects, l, x, y);
      if (objectSeen === 1) {
        continue;
      }
      const hidden = lamp * (1 - objectSeen) * OBJECT_SHADOW_DARKNESS;
      shadeCell(lm, l, cell, slot, x, y, hidden, 1 - (1 - objectSeen) * cut, albedo, tables);
    }
  }
}

/** How much of lamp `l` the floor at (x, y) sees past every object it lights round: the product of their shares. */
function seenPastObjects(lm: Lighting, objects: readonly VoxelInstance[], l: Light, x: number, y: number): number {
  let seen = 1;
  for (const v of objects) {
    if (casts(lm, v, l)) {
      seen *= objectSeenShare(v, l, x, y);
    }
  }
  return seen;
}

/**
 * Takes `hidden` of lamp `l`'s unobstructed light (times how much of the lamp the cell sees past walls, as baked) off
 * the floor cell, and scales its seen share of the lamp in the reflection lists (at `slot`, −1 when unlisted) by
 * `reflectionSeen`.
 */
function shadeCell(
  lm: Lighting,
  l: Light,
  cell: number,
  slot: number,
  x: number,
  y: number,
  hidden: number,
  reflectionSeen: number,
  albedo: number,
  tables: PatchedFloor
): void {
  const pastWalls = slot >= 0 ? (lm.floorLampSeen[slot] as number) / 255 : seenShare(lm.map, lm.portals, x, y, l);
  if (pastWalls === 0) {
    return;
  }
  tables.touch(cell);
  const k = hidden * pastWalls;
  const c = tables.floor[cell] as number;
  const r = Math.max(0, (c & 0xff) - Math.round((albedo & 0xff) * l.r * k));
  const g = Math.max(0, ((c >>> 8) & 0xff) - Math.round(((albedo >>> 8) & 0xff) * l.g * k));
  const b = Math.max(0, ((c >>> 16) & 0xff) - Math.round(((albedo >>> 16) & 0xff) * l.b * k));
  tables.floor[cell] = ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
  if (slot >= 0) {
    tables.floorLampSeen[slot] = Math.round((tables.floorLampSeen[slot] as number) * reflectionSeen);
  }
}

/** The slot of lamp `li` in the cell's reflection lamp list, or −1 when it isn't listed. */
function listedSlot(lm: Lighting, cell: number, li: number): number {
  const first = cell * REFLECTION_LAMPS;
  for (let k = 0; k < REFLECTION_LAMPS; k++) {
    if (lm.floorLamp[first + k] === li) {
      return first + k;
    }
  }
  return -1;
}
