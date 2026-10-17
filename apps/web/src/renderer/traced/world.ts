// The room as the ray tracer sees it: the grid, the lamps as glowing discs set in the ceiling, and every surface's colour
// in linear light (spec docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §3). Pure data and queries.
import { type GameMap, tileAt } from '@zoom3d/shared';
import { GLOSS } from '../textures';
import { CEILING, FLOOR } from '../walls';

/** A lamp is a glowing disc this wide (tiles) set in the ceiling, shining down: the game's fixture. */
export const LAMP_RADIUS = 0.18;
/** The disc's brightness: about 1 on the floor right under it. */
export const LAMP_RADIANCE = 36;
/**
 * The current renderer's lamp colour LAMP (1.25, 1.05, 0.75) is 1, 0.84, 0.6 as a tint. That renderer tints screen
 * colours, so the same warmth in linear light is the tint to the power 2.2; without it the lamps read cold.
 */
const LAMP_TINT = [1, 0.84 ** 2.2, 0.6 ** 2.2] as const;

/** `lampOver` where no lamp's disc is. */
export const NO_LAMP = -1;
/** `faceIndex` where a wall face has no floor in front of it. */
export const NO_FACE = -1;

/**
 * How a surface reflects: `f0` face-on (0.04 for any varnish, paint or stone), `roughness` 0 mirror .. 1 matte, and
 * `tint`, how much a reflection takes on the surface's own colour (0 the light's colour; varnish over wood glows
 * golden).
 */
export interface TracedMaterial {
  f0: number;
  roughness: number;
  tint: number;
}

export const FLOOR_MATERIAL: TracedMaterial = { f0: 0.04, roughness: 0.6, tint: 0 };

/** Index = tile id; 0 is the floor. */
export const TRACED_MATERIALS: readonly TracedMaterial[] = [
  FLOOR_MATERIAL,
  { f0: 0.04, roughness: 0.85, tint: 0.6 },
  { f0: 0.04, roughness: 0.35, tint: 0.75 },
  { f0: 0.04, roughness: 0.85, tint: 0.85 },
];

/** A wall cell's faces, named for the side a ray enters the cell through. */
export const FACE_WEST = 0;
export const FACE_EAST = 1;
export const FACE_NORTH = 2;
export const FACE_SOUTH = 3;
/** Each face's normal (index = FACE_*), pointing into the open cell in front of it. */
export const FACE_NORMAL_X: readonly number[] = [-1, 1, 0, 0];
export const FACE_NORMAL_Y: readonly number[] = [0, 0, -1, 1];

export interface TracedWorld {
  map: GameMap;
  width: number;
  height: number;
  /** Per wall cell and side (cell × 4 + FACE_*), its index among the visible faces, or NO_FACE. */
  faceIndex: Int32Array;
  faceCount: number;
  lampX: Float64Array;
  lampY: Float64Array;
  /** Per tile, the lamp whose disc reaches over it, or NO_LAMP. */
  lampAt: Int16Array;
  /** Every lamp's radiance as linear (r, g, b): LAMP_RADIANCE × the warm tint. */
  lampRgb: Float32Array;
  /** Linear RGB per texel, interleaved, index = tile id (tile 0, the floor, has no texture). */
  albedo: readonly Float32Array[];
  /** Each tile's average linear RGB. */
  meanAlbedo: readonly Float32Array[];
  /** Per texel and tile id, 1 where a lamp can reflect and 0 where it can't (mortar). */
  gloss: readonly Uint8Array[];
  floorAlbedo: Float32Array;
  ceilingAlbedo: Float32Array;
}

export function buildTracedWorld(
  map: GameMap,
  textures: readonly Uint32Array[],
  lamps: readonly { x: number; y: number }[]
): TracedWorld {
  const { faceIndex, faceCount } = indexFaces(map);
  const albedo = textures.map(linearAlbedoOf);
  return {
    map,
    width: map.width,
    height: map.height,
    faceIndex,
    faceCount,
    lampX: Float64Array.from(lamps, (lamp) => lamp.x),
    lampY: Float64Array.from(lamps, (lamp) => lamp.y),
    lampAt: indexLampTiles(map, lamps),
    lampRgb: Float32Array.from(LAMP_TINT, (tint) => tint * LAMP_RADIANCE),
    albedo,
    meanAlbedo: albedo.map(meanOf),
    gloss: GLOSS,
    floorAlbedo: linearRgbOf(FLOOR),
    ceilingAlbedo: linearRgbOf(CEILING),
  };
}

/** Whether tile (x, y) is a wall; off the map counts as wall. */
export function isWall(world: TracedWorld, x: number, y: number): boolean {
  return tileAt(world.map, x, y) !== 0;
}

/**
 * The lamp whose disc covers the ceiling point (x, y), in tiles, or NO_LAMP. Per ceiling hit in the frame, so it reads
 * typed arrays by index: a loop of queries took 62 ns each with `.at()`, 22 ns by index.
 */
export function lampOver(world: TracedWorld, x: number, y: number): number {
  const tileX = Math.floor(x);
  const tileY = Math.floor(y);
  if (!insideMap(world, tileX, tileY)) {
    return NO_LAMP;
  }
  const lamp = world.lampAt[tileY * world.width + tileX] ?? NO_LAMP;
  if (lamp === NO_LAMP) {
    return NO_LAMP;
  }
  const fromCentreX = x - (world.lampX[lamp] ?? 0);
  const fromCentreY = y - (world.lampY[lamp] ?? 0);
  return fromCentreX * fromCentreX + fromCentreY * fromCentreY < LAMP_RADIUS * LAMP_RADIUS ? lamp : NO_LAMP;
}

function insideMap(size: { width: number; height: number }, tileX: number, tileY: number): boolean {
  return tileX >= 0 && tileY >= 0 && tileX < size.width && tileY < size.height;
}

/** Numbers every wall face that has floor in front of it, cell by cell, in FACE_* order. */
function indexFaces(map: GameMap): { faceIndex: Int32Array; faceCount: number } {
  const faceIndex = new Int32Array(map.width * map.height * 4).fill(NO_FACE);
  let faceCount = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (tileAt(map, x, y) === 0) {
        continue;
      }
      for (const [side, normalX] of FACE_NORMAL_X.entries()) {
        const normalY = FACE_NORMAL_Y.at(side) ?? 0;
        if (tileAt(map, x + normalX, y + normalY) === 0) {
          faceIndex[(y * map.width + x) * 4 + side] = faceCount++;
        }
      }
    }
  }
  return { faceIndex, faceCount };
}

/** Marks every tile a lamp's disc reaches over: a disc on a tile boundary reaches two or four. */
function indexLampTiles(map: GameMap, lamps: readonly { x: number; y: number }[]): Int16Array {
  const lampAt = new Int16Array(map.width * map.height).fill(NO_LAMP);
  for (const [lamp, { x, y }] of lamps.entries()) {
    for (let tileY = Math.floor(y - LAMP_RADIUS); tileY <= Math.floor(y + LAMP_RADIUS); tileY++) {
      for (let tileX = Math.floor(x - LAMP_RADIUS); tileX <= Math.floor(x + LAMP_RADIUS); tileX++) {
        if (insideMap(map, tileX, tileY)) {
          lampAt[tileY * map.width + tileX] = lamp;
        }
      }
    }
  }
  return lampAt;
}

function linearAlbedoOf(texture: Uint32Array): Float32Array {
  const albedo = new Float32Array(texture.length * 3);
  for (const [texel, packed] of texture.entries()) {
    albedo.set(linearRgbOf(packed), texel * 3);
  }
  return albedo;
}

function meanOf(albedo: Float32Array): Float32Array {
  const texels = albedo.length / 3;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let at = 0; at < albedo.length; at += 3) {
    red += albedo.at(at) ?? 0;
    green += albedo.at(at + 1) ?? 0;
    blue += albedo.at(at + 2) ?? 0;
  }
  return Float32Array.of(red / (texels || 1), green / (texels || 1), blue / (texels || 1));
}

/** A packed 0xAABBGGRR colour (see `rgb`) as linear light. */
function linearRgbOf(packed: number): Float32Array {
  return Float32Array.of(
    linearOfSrgbChannel(packed & 0xff),
    linearOfSrgbChannel((packed >>> 8) & 0xff),
    linearOfSrgbChannel((packed >>> 16) & 0xff)
  );
}

function linearOfSrgbChannel(byte: number): number {
  const encoded = byte / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}
