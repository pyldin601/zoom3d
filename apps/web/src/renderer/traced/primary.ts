// The primary pass: what each pixel sees directly, as linear light from the bake and as the Fresnel weight a reflection
// would take (spec docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §3). Walls column by column, as
// renderWalls casts them, then floor and ceiling row by row. Allocation-free, with per-pixel loops kept inline.
import { castRay, createRayHit, type RayHit } from '@zoom3d/shared';
import { EYE_HEIGHT } from '../camera';
import type { Framebuffer } from '../framebuffer';
import { TEX } from '../textures';
import type { TracedBuffers } from './buffers';
import { FLOOR_CELLS, type TracedLightmaps, WALL_HEIGHTS, wallColumnLight } from './lightmaps';
import { fresnel } from './optics';
import {
  FACE_EAST,
  FACE_NORMAL_X,
  FACE_NORMAL_Y,
  FACE_NORTH,
  FACE_SOUTH,
  FACE_WEST,
  FLOOR_MATERIAL,
  lampOver,
  NO_FACE,
  NO_LAMP,
  TRACED_MATERIALS,
  type TracedMaterial,
  type TracedWorld,
} from './world';

/** castRay's `side` for a west or east face. */
const X_SIDE = 0;
/** The spans between a face's sample heights, across which a wall pixel's light is blended. */
const WALL_SEGMENTS = WALL_HEIGHTS - 1;

const NO_ALBEDO = new Float32Array(0);
const NO_GLOSS = new Uint8Array(0);

const hit = createRayHit();

/** The wall column being drawn: filled by `castColumn` and `findColumnSurface`, then read by the stages after them. */
interface WallColumn {
  col: number;
  /** The rows its wall covers, [start, end); equal when it shows none. */
  start: number;
  end: number;
  /** Perpendicular to the camera plane, in tiles. */
  distance: number;
  rayX: number;
  rayY: number;
  /** FACE_* of the face the ray hit. */
  face: number;
  tile: number;
  texX: number;
  /** The tile's texture in linear light. */
  albedo: Float32Array;
  /** Per texel, 1 where a lamp can reflect. */
  gloss: Uint8Array;
  material: TracedMaterial;
}

const column: WallColumn = {
  col: 0,
  start: 0,
  end: 0,
  distance: 0,
  rayX: 0,
  rayY: 0,
  face: 0,
  tile: 0,
  texX: 0,
  albedo: NO_ALBEDO,
  gloss: NO_GLOSS,
  material: FLOOR_MATERIAL,
};
/** The light on the column's face at the sample heights, r, g, b, from the floor up. */
const columnLight = new Float32Array(WALL_HEIGHTS * 3);

/** The floor or ceiling points along the row being drawn, in light cells: under pixel column 0, and per column. */
const planeRow = { cellX: 0, cellY: 0, stepCellX: 0, stepCellY: 0 };

/**
 * Draws every wall pixel into `buffers.hdr`, `spec` and `specTile`, and fills `fb.zbuffer` and the rows each column's
 * wall covers.
 */
export function drawWalls(fb: Framebuffer, buffers: TracedBuffers, world: TracedWorld, maps: TracedLightmaps): void {
  for (let col = 0; col < fb.width; col++) {
    castColumn(fb, buffers, world, col);
    if (column.end > column.start) {
      findColumnSurface(world);
      lightColumn(world, maps);
      drawWallPixels(buffers);
    }
  }
}

/**
 * Draws the floor and ceiling pixels the walls leave. A ceiling point inside a lamp's disc shows the lamp. Needs the
 * rows each column's wall covers, from `drawWalls`.
 */
export function drawFloorAndCeiling(buffers: TracedBuffers, world: TracedWorld, maps: TracedLightmaps): void {
  for (let row = 0; row < buffers.height; row++) {
    aimPlaneRow(buffers, row);
    if (row + 0.5 < buffers.view.half) {
      drawPlaneRow(buffers, world, maps.ceiling, world.ceilingAlbedo, row, 'ceiling');
    } else {
      drawPlaneRow(buffers, world, maps.floor, world.floorAlbedo, row, 'floor');
    }
  }
}

/** The face (FACE_*) a 2D ray along (rayX, rayY) entered its wall through, from castRay's `hit`. */
export function faceEntered(hit: RayHit, rayX: number, rayY: number): number {
  // A ray heading +x enters a west face, one heading +y a north face.
  if (hit.side === X_SIDE) {
    return rayX > 0 ? FACE_WEST : FACE_EAST;
  }
  return rayY > 0 ? FACE_NORTH : FACE_SOUTH;
}

/** The texel column a 2D ray along (rayX, rayY) meets its wall at, from castRay's `hit`: the one renderWalls shows. */
export function texelColumnOf(hit: RayHit, rayX: number, rayY: number): number {
  // wallX can round up to 1. The texel column is flipped on two of the four faces, as renderWalls does.
  const texX = Math.min(TEX - 1, Math.floor(hit.wallX * TEX));
  return (hit.side === X_SIDE && rayX > 0) || (hit.side !== X_SIDE && rayY < 0) ? TEX - 1 - texX : texX;
}

// Wall columns.

/** Casts screen column `col` with the ray `renderWalls` casts, into `hit` and `column`; fills the z-buffer. */
function castColumn(fb: Framebuffer, buffers: TracedBuffers, world: TracedWorld, col: number): void {
  const { x, y, dirX, dirY, planeX, planeY, proj, half } = buffers.view;
  const cameraX = (2 * col) / fb.width - 1;
  const rayX = dirX + planeX * cameraX;
  const rayY = dirY + planeY * cameraX;
  castRay(world.map, x, y, rayX, rayY, hit);
  fb.zbuffer[col] = hit.distance;

  const wallHeightPx = hit.tile === 0 ? 0 : proj / hit.distance;
  const start = Math.max(0, Math.floor(half - wallHeightPx / 2));
  const end = Math.max(start, Math.min(fb.height, Math.floor(half + wallHeightPx / 2)));
  buffers.wallStart[col] = start;
  buffers.wallEnd[col] = end;

  column.col = col;
  column.start = start;
  column.end = end;
  column.distance = hit.distance;
  column.rayX = rayX;
  column.rayY = rayY;
  column.face = faceEntered(hit, rayX, rayY);
  column.tile = hit.tile;
  column.texX = texelColumnOf(hit, rayX, rayY);
}

/** What the column's tile is made of: its texture's linear colour, where it shines, and how. */
function findColumnSurface(world: TracedWorld): void {
  const albedo = world.albedo[column.tile];
  if (!albedo) {
    throw new Error(`wall tile ${column.tile} has no texture`);
  }
  column.albedo = albedo;
  column.gloss = world.gloss[column.tile] ?? NO_GLOSS;
  column.material = TRACED_MATERIALS[column.tile] ?? FLOOR_MATERIAL;
}

/** The face's baked light where the ray hit it, at each sample height, into `columnLight`. */
function lightColumn(world: TracedWorld, maps: TracedLightmaps): void {
  const faceIndex = world.faceIndex[(hit.mapY * world.width + hit.mapX) * 4 + column.face] ?? NO_FACE;
  // wallX runs along +x on a north or south face and +y on a west or east one, the way a face's samples do.
  wallColumnLight(maps, faceIndex, hit.wallX, columnLight);
}

/**
 * Each wall pixel is its texel's colour times the baked light at its height, blended between the sample heights; where
 * the texel can reflect, `spec` is the Fresnel weight at the slant the pixel is seen at.
 */
function drawWallPixels(buffers: TracedBuffers): void {
  const { width, hdr, spec, specTile, view } = buffers;
  const { col, start, end, distance, rayX, rayY, face, tile, texX, albedo, gloss, material } = column;
  const { proj, half } = view;
  // The pixel's 3D ray is (rayX, rayY, rise): its cosine to the face's normal is how head-on the face is seen.
  const headOn = Math.abs((FACE_NORMAL_X[face] ?? 0) * rayX + (FACE_NORMAL_Y[face] ?? 0) * rayY);
  const runSquared = rayX * rayX + rayY * rayY;
  for (let row = start; row < end; row++) {
    const rise = (half - (row + 0.5)) / proj;
    const height = EYE_HEIGHT + rise * distance;
    // Rounding at the wall's edges can put a pixel's centre a hair off the wall.
    const z = height < 0 ? 0 : height > 1 ? 1 : height;
    const texel = Math.min(TEX - 1, ((1 - z) * TEX) | 0) * TEX + texX;
    const scaled = z * WALL_SEGMENTS;
    const below = scaled >= WALL_SEGMENTS ? WALL_SEGMENTS - 1 : scaled | 0;
    const above = scaled - below;
    const at = below * 3;
    const pixel = row * width + col;
    const lowerRed = columnLight[at] ?? 0;
    const lowerGreen = columnLight[at + 1] ?? 0;
    const lowerBlue = columnLight[at + 2] ?? 0;
    hdr[pixel * 3] = (albedo[texel * 3] ?? 0) * (lowerRed + ((columnLight[at + 3] ?? 0) - lowerRed) * above);
    hdr[pixel * 3 + 1] =
      (albedo[texel * 3 + 1] ?? 0) * (lowerGreen + ((columnLight[at + 4] ?? 0) - lowerGreen) * above);
    hdr[pixel * 3 + 2] = (albedo[texel * 3 + 2] ?? 0) * (lowerBlue + ((columnLight[at + 5] ?? 0) - lowerBlue) * above);
    specTile[pixel] = tile;
    spec[pixel] = gloss[texel] === 1 ? fresnel(headOn / Math.sqrt(runSquared + rise * rise), material) : 0;
  }
}

// Floor and ceiling.

/** Aims `planeRow` at screen row `row`: along a row the floor point moves linearly, so it is stepped, not re-projected. */
function aimPlaneRow(buffers: TracedBuffers, row: number): void {
  const { x, y, dirX, dirY, planeX, planeY } = buffers.view;
  const distance = buffers.rowDistance[row] ?? 0;
  const stepPerColumn = (distance * 2) / buffers.width;
  // Light samples sit at cell centres, so a point's cell coordinate is half a cell back.
  planeRow.cellX = (x + distance * (dirX - planeX)) * FLOOR_CELLS - 0.5;
  planeRow.cellY = (y + distance * (dirY - planeY)) * FLOOR_CELLS - 0.5;
  planeRow.stepCellX = stepPerColumn * planeX * FLOOR_CELLS;
  planeRow.stepCellY = stepPerColumn * planeY * FLOOR_CELLS;
}

/**
 * The pixels of row `row` no wall covers: each is `albedo` times the bilinear light of `light` at its point, the same
 * blend as `planeLight` written out: called per pixel, it took 1.39 ms a 640×360 frame for the floor and ceiling
 * against 0.90 ms. A ceiling point inside a lamp's disc is the lamp.
 */
function drawPlaneRow(
  buffers: TracedBuffers,
  world: TracedWorld,
  light: Float32Array,
  albedo: Float32Array,
  row: number,
  surface: 'floor' | 'ceiling'
): void {
  const { width, hdr, spec, specTile, floorFresnel, wallStart, wallEnd } = buffers;
  const ceiling = surface === 'ceiling';
  const cellsAcross = world.width * FLOOR_CELLS;
  const lastCellX = cellsAcross - 1;
  const lastCellY = world.height * FLOOR_CELLS - 1;
  const albedoRed = albedo[0] ?? 0;
  const albedoGreen = albedo[1] ?? 0;
  const albedoBlue = albedo[2] ?? 0;
  const lampRed = world.lampRgb[0] ?? 0;
  const lampGreen = world.lampRgb[1] ?? 0;
  const lampBlue = world.lampRgb[2] ?? 0;
  const { stepCellX, stepCellY } = planeRow;
  let cellX = planeRow.cellX;
  let cellY = planeRow.cellY;
  for (let col = 0; col < width; col++, cellX += stepCellX, cellY += stepCellY) {
    if (ceiling ? row >= (wallStart[col] ?? 0) : row < (wallEnd[col] ?? 0)) {
      continue;
    }
    const pixel = row * width + col;
    specTile[pixel] = 0;
    if (ceiling) {
      spec[pixel] = 0;
      if (lampOver(world, (cellX + 0.5) / FLOOR_CELLS, (cellY + 0.5) / FLOOR_CELLS) !== NO_LAMP) {
        hdr[pixel * 3] = lampRed;
        hdr[pixel * 3 + 1] = lampGreen;
        hdr[pixel * 3 + 2] = lampBlue;
        continue;
      }
    } else {
      spec[pixel] = floorFresnel[pixel] ?? 0;
    }
    // Beyond the map the edge sample is taken.
    const atX = cellX < 0 ? 0 : cellX > lastCellX ? lastCellX : cellX;
    const atY = cellY < 0 ? 0 : cellY > lastCellY ? lastCellY : cellY;
    const westCell = Math.min(lastCellX - 1, atX | 0);
    const northCell = Math.min(lastCellY - 1, atY | 0);
    const shareEast = atX - westCell;
    const shareSouth = atY - northCell;
    const north = (northCell * cellsAcross + westCell) * 3;
    const south = north + cellsAcross * 3;
    const northRed = (light[north] ?? 0) + ((light[north + 3] ?? 0) - (light[north] ?? 0)) * shareEast;
    const southRed = (light[south] ?? 0) + ((light[south + 3] ?? 0) - (light[south] ?? 0)) * shareEast;
    const northGreen = (light[north + 1] ?? 0) + ((light[north + 4] ?? 0) - (light[north + 1] ?? 0)) * shareEast;
    const southGreen = (light[south + 1] ?? 0) + ((light[south + 4] ?? 0) - (light[south + 1] ?? 0)) * shareEast;
    const northBlue = (light[north + 2] ?? 0) + ((light[north + 5] ?? 0) - (light[north + 2] ?? 0)) * shareEast;
    const southBlue = (light[south + 2] ?? 0) + ((light[south + 5] ?? 0) - (light[south + 2] ?? 0)) * shareEast;
    hdr[pixel * 3] = (northRed + (southRed - northRed) * shareSouth) * albedoRed;
    hdr[pixel * 3 + 1] = (northGreen + (southGreen - northGreen) * shareSouth) * albedoGreen;
    hdr[pixel * 3 + 2] = (northBlue + (southBlue - northBlue) * shareSouth) * albedoBlue;
  }
}
