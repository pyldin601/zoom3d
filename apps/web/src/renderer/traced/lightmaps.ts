// Where baked light lives and how a point between samples blends them (spec
// docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §3.2). Pure layout and lookups; the bake fills it.
import { NO_FACE, type TracedWorld } from './world';

/** Floor and ceiling light samples per tile side. */
export const FLOOR_CELLS = 8;
/** Wall light samples across a face. */
export const WALL_COLUMNS = 8;
/** Wall light samples up a face: at the floor, the middle and the ceiling. */
export const WALL_HEIGHTS = 3;

/**
 * Every map is linear rgb irradiance, interleaved. Floor and ceiling are row-major, `(width · 8) × (height · 8)`
 * cells; walls are `faceIndex`, then row (up), then column (across): see `wallSampleOffset`.
 */
export interface TracedLightmaps {
  floor: Float32Array;
  ceiling: Float32Array;
  wall: Float32Array;
  /** Floor and ceiling light averaged over about a tile: what a rough reflection's wide cone sees. */
  floorSoft: Float32Array;
  ceilingSoft: Float32Array;
  /** The floor's bounce light alone, without the lamps' direct light. */
  floorBounce: Float32Array;
}

/** A wall sample row's height up the wall, 0 (floor) to 1 (ceiling). */
export function wallSampleHeight(row: number): number {
  return row / (WALL_HEIGHTS - 1);
}

/** All zero: pure rays, so a room without lamps is dark. */
export function createLightmaps(world: TracedWorld): TracedLightmaps {
  const planeFloats = world.width * FLOOR_CELLS * world.height * FLOOR_CELLS * 3;
  return {
    floor: new Float32Array(planeFloats),
    ceiling: new Float32Array(planeFloats),
    wall: new Float32Array(world.faceCount * WALL_HEIGHTS * WALL_COLUMNS * 3),
    floorSoft: new Float32Array(planeFloats),
    ceilingSoft: new Float32Array(planeFloats),
    floorBounce: new Float32Array(planeFloats),
  };
}

/** Where floor or ceiling cell (cellX, cellY), counted across the whole map, starts in a plane map. */
export function planeCellOffset(world: TracedWorld, cellX: number, cellY: number): number {
  return (cellY * world.width * FLOOR_CELLS + cellX) * 3;
}

/** Where sample (row, column) of a wall face starts in `TracedLightmaps.wall`. */
export function wallSampleOffset(faceIndex: number, row: number, column: number): number {
  return ((faceIndex * WALL_HEIGHTS + row) * WALL_COLUMNS + column) * 3;
}

/**
 * Bilinear light of a floor or ceiling map at the point (x, y), in tiles, into `out`. Beyond the map it takes the edge
 * sample. Per pixel in the frame, so it reads by index: 15 ns a call against 240 ns with `.at()`.
 */
export function planeLight(lm: Float32Array, world: TracedWorld, x: number, y: number, out: Float32Array): void {
  const cellsAcross = world.width * FLOOR_CELLS;
  const cellsDown = world.height * FLOOR_CELLS;
  // Samples sit at cell centres, so a point is between the cell before it and the one after.
  const cellX = x * FLOOR_CELLS - 0.5;
  const cellY = y * FLOOR_CELLS - 0.5;
  const westCell = Math.floor(cellX);
  const northCell = Math.floor(cellY);
  const shareEast = cellX - westCell;
  const shareSouth = cellY - northCell;
  const west = clampIndex(westCell, cellsAcross);
  const east = clampIndex(westCell + 1, cellsAcross);
  const north = clampIndex(northCell, cellsDown) * cellsAcross;
  const south = clampIndex(northCell + 1, cellsDown) * cellsAcross;
  for (let channel = 0; channel < 3; channel++) {
    const northLight = blend(lm[(north + west) * 3 + channel], lm[(north + east) * 3 + channel], shareEast);
    const southLight = blend(lm[(south + west) * 3 + channel], lm[(south + east) * 3 + channel], shareEast);
    out[channel] = blend(northLight, southLight, shareSouth);
  }
}

/**
 * A wall face's light at `u` (0..1 across it): linear between its column centres, at each of the 3 heights, into
 * `out[row · 3 + channel]`. NO_FACE gives zeros. Per wall column in the frame, so it reads by index: 25 ns a call
 * against 360 ns with `.at()`.
 */
export function wallColumnLight(maps: TracedLightmaps, faceIndex: number, u: number, out: Float32Array): void {
  if (faceIndex === NO_FACE) {
    out.fill(0, 0, WALL_HEIGHTS * 3);
    return;
  }
  const column = u * WALL_COLUMNS - 0.5;
  const leftColumn = Math.floor(column);
  const shareRight = column - leftColumn;
  const left = clampIndex(leftColumn, WALL_COLUMNS);
  const right = clampIndex(leftColumn + 1, WALL_COLUMNS);
  for (let row = 0; row < WALL_HEIGHTS; row++) {
    const leftAt = wallSampleOffset(faceIndex, row, left);
    const rightAt = wallSampleOffset(faceIndex, row, right);
    for (let channel = 0; channel < 3; channel++) {
      out[row * 3 + channel] = blend(maps.wall[leftAt + channel], maps.wall[rightAt + channel], shareRight);
    }
  }
}

function clampIndex(index: number, length: number): number {
  return Math.min(length - 1, Math.max(0, index));
}

/** `from` to `to` by `share`; typed-array reads come in as possibly undefined, and an unread sample is dark. */
function blend(from: number | undefined, to: number | undefined, share: number): number {
  const start = from ?? 0;
  return start + ((to ?? 0) - start) * share;
}
