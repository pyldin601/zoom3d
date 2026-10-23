// The room as the eye sees it: walls ray-cast column by column, then floor and ceiling row by row. Lit (decision D24)
// by the baked lamps, the avatars' glow and the lamps' reflections; unlit, plain textures over a flat floor and
// ceiling. Allocation-free per frame: scratch buffers are rebuilt only when the frame's size or FOV changes.

import { castRay, createRayHit, type GameMap, type PlayerState } from '@zoom3d/shared';
import { createView, EYE_HEIGHT, setView } from './camera';
import { reflectedColour } from './colour';
import { type Framebuffer, rgb, scaleRgb } from './framebuffer';
import { GLOW_RADIUS, type Glow, glowLight } from './glow';
import {
  bounceHeight,
  distanceToWall,
  FACE_NORMALS,
  FLOOR_NORMAL,
  FLOOR_SUB,
  type Lighting,
  type Normal,
  REFLECTION_LAMPS,
  REFLECTION_NEAR,
  REFLECTION_RANGE,
  REFLECTION_SAMPLES,
  REFLECTION_STRENGTH,
  type ReflectionMode,
  reflection,
  WALL_U,
  WALL_V,
} from './lighting';
import { createMirrorBuffer } from './mirror';
import { type PatchedFloor, shadeFloor } from './object-shadows';
import { GLOSS, REFLECTION_MATERIAL, RELIEF, RELIEF_LEVELS, type ReflectionMaterial, TEX } from './textures';
import { renderVoxelMirror, type VoxelInstance, voxelDepth } from './voxels';

/** The unlit ceiling's colour, and the colour the lit one is baked from. */
export const CEILING = rgb(0x38, 0x38, 0x38);
/** The unlit floor's colour, and the colour the lit one is baked from. */
export const FLOOR = rgb(0x70, 0x70, 0x70);
/** A smooth, semi-glossy floor: lamps smear along it towards the eye. */
const FLOOR_MATERIAL: ReflectionMaterial = { shininess: 16, f0: 0.1, tint: 0 };
/** Floor reflections are worked out every this many pixels along every other row, and blended between. */
const FLOOR_REFLECTION_STEP_PX = 16;
/**
 * The ceiling reflects the lamps' light off the floor, this much of what the floor reflects: each lamp mirrored in
 * the floor, as far under it as the lamp is over it. Only the lamps' light, never the floor, its walls or doorways.
 */
const CEILING_SHINE = 0.5;
/** Under half a step of brightness (×255 scale) a reflection shows nothing, so it isn't drawn. */
const VISIBLE_SHINE = 0.5;
/** The eye is always half a tile off the floor's face, so the floor's reflection fades by a constant (REFLECTION_NEAR). */
const FLOOR_SHINE_SCALE = (() => {
  const near = 0.5 / REFLECTION_NEAR;
  return (1 - near * near) * 255 * REFLECTION_STRENGTH;
})();
/** Avatar glow is worked out at this many heights up a wall column and blended per texel row. */
const GLOW_HEIGHTS = 9;
/** Opaque black, under the reflections alone. */
const BLACK = 0xff000000;
/** castRay's `side` for a west or east face, and for a north or south one. */
const X_SIDE = 0;
const Y_SIDE = 1;

/** The room renderWalls draws: `map` with its wall `textures`, seen from `eye`. */
export interface Room {
  map: GameMap;
  textures: Uint32Array[];
  eye: PlayerState;
  /** null draws the room unlit. */
  lighting: Lighting | null;
  /** The surfaces that show the lamps' reflections in a lit room; 'both' when left out. */
  reflections?: ReflectionMode;
  /** Voxel objects, whose shadows a lit room's floor shows; none when left out. */
  objects?: readonly VoxelInstance[];
}

/** The floor (or ceiling) points along one screen row, in lightmap cells. */
interface FloorRow {
  /** Under pixel column 0. */
  x: number;
  y: number;
  /** Per pixel column. */
  stepX: number;
  stepY: number;
}

/** What a lit frame is drawn from, set once per frame by `litRoomFor`. */
interface LitRoom extends Room {
  lighting: Lighting;
  reflections: ReflectionMode;
  glows: readonly Glow[];
  objects: readonly VoxelInstance[];
  /** What one unit of each lamp's reflection adds, r, g, b, per texture then the floor (see reflectionColours). */
  reflectionColours: Float64Array;
}

const NO_GLOWS: readonly Glow[] = [];
const NO_OBJECTS: readonly VoxelInstance[] = [];
const mirror = createMirrorBuffer();
/** Objects in front of the eye, far to near, with their depths, for their mirrors. */
const mirrorOrder: number[] = [];
const mirrorDepths: number[] = [];
const mirrorsFarFirst = (a: number, b: number) => Math.sign((mirrorDepths[b] as number) - (mirrorDepths[a] as number));
const view = createView();
const hit = createRayHit();
let litRoom: LitRoom | null = null;

/** Rebuilt by fitScratchToFrame when the frame's size or FOV changes. */
let scratchSize = { width: 0, height: 0, fov: 0 };
/** Per screen row, the perpendicular distance to the floor or ceiling it shows, in lightmap cells. */
let rowDistance = new Float64Array(0);
/** Per screen column, the rows its wall covers, [start, end). */
let wallStart = new Int32Array(0);
let wallEnd = new Int32Array(0);
/** One floor or ceiling row's reflection every FLOOR_REFLECTION_STEP_PX (0 where it doesn't show), and its lamp. */
let rowShine = new Float64Array(0);
let rowShineLamp = new Int32Array(0);
/** The row aimFloorRow last aimed at. */
const floorRow: FloorRow = { x: 0, y: 0, stepX: 0, stepY: 0 };

let reflectionColoursFor: { lm: Lighting; textures: Uint32Array[] } | null = null;
let reflectionColourTable = new Float64Array(0);
let blackTables: FloorTables | null = null;

/** The wall column being drawn: filled by castColumnRay and findColumnFace, then read by the passes after them. */
const column = {
  col: 0,
  /** Rows the wall covers, [start, end); equal when it shows none. */
  start: 0,
  end: 0,
  wallHeightPx: 0,
  tile: 0,
  texX: 0,
  /** X_SIDE for a west or east face, Y_SIDE for a north or south one. */
  side: 0,
  rayX: 0,
  rayY: 0,
  normal: FACE_NORMALS[0] as Normal,
  /** The face's offset into the Lighting's tables; −1 when no floor lies in front of it. */
  faceOffset: -1,
  /** The face's column of baked samples: its offset into `wall`. */
  lightCol: 0,
  hitX: 0,
  hitY: 0,
  /** Perpendicular to the camera plane, in tiles. */
  distance: 0,
  /** Whether a lamp's reflection shows on it: per height in columnShine, with the lamp in columnShineLamp. */
  shines: false,
  /** How many avatars glow on it: the first of columnGlows; their light per height is in columnGlowLight. */
  glows: 0,
};
/** The column's reflection at REFLECTION_SAMPLES heights from the floor up, and the lamp it shows at each. */
const columnShine = new Float64Array(REFLECTION_SAMPLES);
const columnShineLamp = new Int32Array(REFLECTION_SAMPLES);
const columnGlows: Glow[] = [];
/** The avatars' glow on the column, r, g, b, at GLOW_HEIGHTS heights from the floor up. */
const columnGlowLight = new Float64Array(GLOW_HEIGHTS * 3);

/** A frame's floor and ceiling colours per floor cell, and how much of each listed lamp each floor cell sees. */
interface FloorTables {
  floor: Uint32Array;
  ceiling: Uint32Array;
  floorLampSeen: Uint8Array;
}

/**
 * The floor tables with this frame's object shadows and avatar glow: copies of a Lighting's, whose cells were patched
 * (the first `dirtyCount` of `dirty`) are put back next frame. `light` sums the glow on each cell, r, g, b.
 */
let frameTables:
  | (FloorTables &
      PatchedFloor & {
        lm: Lighting;
        touched: Uint8Array;
        /** A typed array and a count, not an array emptied each frame: V8 drops an array's storage at `length = 0`. */
        dirty: Int32Array;
        dirtyCount: number;
        light: Float32Array;
      })
  | null = null;

/**
 * Draws `room` into `fb` and fills its z-buffer. A lit room's walls, floor and ceiling show the lamps' reflections on
 * the surfaces `room.reflections` picks, and the avatars' `glows`.
 */
export function renderWalls(fb: Framebuffer, room: Room, glows: readonly Glow[] = NO_GLOWS): void {
  setView(view, fb, room.eye);
  if (room.lighting) {
    drawLitRoom(fb, litRoomFor(room, room.lighting, glows));
  } else {
    drawUnlitRoom(fb, room);
  }
}

const reflectsOnWalls = (mode: ReflectionMode) => mode !== 'none';
const reflectsOnFloor = (mode: ReflectionMode) => mode === 'both' || mode === 'only';
/** 'only' draws the reflections alone, on black: no baked light and no glow under them. */
const lampsLightTheRoom = (mode: ReflectionMode) => mode !== 'only';

// The unlit room.

function drawUnlitRoom(fb: Framebuffer, room: Room): void {
  for (let col = 0; col < fb.width; col++) {
    castColumnRay(fb, room, col);
    fillColumn(fb, col, 0, column.start, CEILING);
    drawPlainWallSlice(fb, room.textures, column.side === Y_SIDE ? 'shaded' : 'unshaded');
    fillColumn(fb, col, column.end, fb.height, FLOOR);
  }
}

function fillColumn(fb: Framebuffer, col: number, fromRow: number, toRow: number, colour: number): void {
  const { width: w, pixels } = fb;
  for (let y = fromRow; y < toRow; y++) {
    pixels[y * w + col] = colour;
  }
}

function drawPlainWallSlice(fb: Framebuffer, textures: Uint32Array[], shading: 'shaded' | 'unshaded'): void {
  const { width: w, pixels } = fb;
  const { col, start, end, wallHeightPx, tile, texX } = column;
  const tex = textures[tile] as Uint32Array;
  const shaded = shading === 'shaded';
  const step = TEX / wallHeightPx;
  let texPos = (start - view.half + wallHeightPx / 2) * step;
  // A near wall shows each texel on many rows: shade it once and repeat it.
  let texelY = -1;
  let texel = 0;
  for (let y = start; y < end; y++) {
    // A wall under a texture's height steps over a texel per row, so its top row can start over a texel above the
    // texture (texPos < −1): it shows the top texel.
    const texY = texPos < 0 ? 0 : Math.min(TEX - 1, texPos | 0);
    texPos += step;
    if (texY !== texelY) {
      texelY = texY;
      const c = tex[texY * TEX + texX] as number;
      // SIDE_SHADE (lighting.ts) as a literal: read from the constant, this loop measured 3% slower (bench:walls).
      texel = shaded ? scaleRgb(c, 0.7) : c;
    }
    pixels[y * w + col] = texel;
  }
}

// The lit room.

function drawLitRoom(fb: Framebuffer, room: LitRoom): void {
  fitScratchToFrame(fb);
  drawWallColumns(fb, room);
  const tables = floorAndCeilingColours(room);
  drawFloorAndCeiling(fb, room, tables.floor, tables.ceiling);
  if (reflectsOnFloor(room.reflections)) {
    addFloorAndCeilingReflections(fb, room, tables.floorLampSeen);
    drawObjectMirrors(fb, room);
  }
}

/** The objects' images in the floor, far to near, under the floor's walls (voxel shadows spec §3.3). */
function drawObjectMirrors(fb: Framebuffer, room: LitRoom): void {
  const { objects } = room;
  let count = 0;
  for (let i = 0; i < objects.length; i++) {
    const depth = voxelDepth(view, objects[i] as VoxelInstance);
    if (depth >= 0) {
      mirrorDepths[i] = depth;
      mirrorOrder[count++] = i;
    }
  }
  // Written by index and trimmed after: `length = 0` would make V8 drop the array's storage every frame.
  mirrorOrder.length = count;
  mirrorOrder.sort(mirrorsFarFirst);
  for (const i of mirrorOrder) {
    renderVoxelMirror(fb, view, objects[i] as VoxelInstance, room.lighting, mirror, wallEnd);
  }
}

function litRoomFor(room: Room, lighting: Lighting, glows: readonly Glow[]): LitRoom {
  const { map, eye, textures, reflections = 'both', objects = NO_OBJECTS } = room;
  const reflectionColours = reflectionColoursOf(textures, lighting);
  if (!litRoom) {
    litRoom = { map, eye, lighting, textures, reflections, glows, objects, reflectionColours };
    return litRoom;
  }
  litRoom.objects = objects;
  litRoom.map = map;
  litRoom.eye = eye;
  litRoom.lighting = lighting;
  litRoom.textures = textures;
  litRoom.reflections = reflections;
  litRoom.glows = glows;
  litRoom.reflectionColours = reflectionColours;
  return litRoom;
}

/** Needs setView first. */
function fitScratchToFrame(fb: Framebuffer): void {
  const { width: w, height: h, fov } = fb;
  if (scratchSize.width === w && scratchSize.height === h && scratchSize.fov === fov) {
    return;
  }
  const { proj, half } = view;
  rowDistance = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    rowDistance[y] = ((EYE_HEIGHT * proj) / Math.abs(y + 0.5 - half)) * FLOOR_SUB;
  }
  wallStart = new Int32Array(w);
  wallEnd = new Int32Array(w);
  rowShine = new Float64Array(Math.ceil(w / FLOOR_REFLECTION_STEP_PX) + 1);
  rowShineLamp = new Int32Array(rowShine.length);
  scratchSize = { width: w, height: h, fov };
}

/**
 * Per texture × lamp, then the floor × lamp (as texture number textures.length): what one unit of that lamp's
 * reflection adds, r, g, b. Worked out from each texture's average shiny texel the first time they're drawn together:
 * OKLab per texel row would cost too much, and a texture's texels share a hue.
 */
function reflectionColoursOf(textures: Uint32Array[], lm: Lighting): Float64Array {
  if (reflectionColoursFor?.lm === lm && reflectionColoursFor.textures === textures) {
    return reflectionColourTable;
  }
  const lights = lm.lights.length;
  reflectionColourTable = new Float64Array((textures.length + 1) * lights * 3);
  const floor = [FLOOR & 0xff, (FLOOR >>> 8) & 0xff, (FLOOR >>> 16) & 0xff] as const;
  lm.lights.forEach((l, i) => {
    reflectionColourTable.set(reflectedColour(floor, l, FLOOR_MATERIAL.tint), (textures.length * lights + i) * 3);
  });
  textures.forEach((tex, tile) => {
    const tint = REFLECTION_MATERIAL.at(tile)?.tint ?? 0;
    const mean = meanShinyTexel(tex, GLOSS[tile]);
    lm.lights.forEach((l, i) => {
      reflectionColourTable.set(reflectedColour(mean, l, tint), (tile * lights + i) * 3);
    });
  });
  reflectionColoursFor = { lm, textures };
  return reflectionColourTable;
}

function meanShinyTexel(tex: Uint32Array, gloss: Uint8Array | undefined): readonly [number, number, number] {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  tex.forEach((c, t) => {
    if (gloss?.[t] === 1) {
      sr += c & 0xff;
      sg += (c >>> 8) & 0xff;
      sb += (c >>> 16) & 0xff;
      n++;
    }
  });
  return [sr / (n || 1), sg / (n || 1), sb / (n || 1)];
}

// Wall columns.

function drawWallColumns(fb: Framebuffer, room: LitRoom): void {
  const glowsLightWalls = lampsLightTheRoom(room.reflections) && room.glows.length > 0;
  for (let col = 0; col < fb.width; col++) {
    castColumnRay(fb, room, col);
    if (column.end === column.start) {
      continue;
    }
    findColumnFace(room);
    if (column.faceOffset < 0) {
      // A face with no floor in front can't be seen: this only guards rounding at the map edge.
      drawPlainWallSlice(fb, room.textures, 'unshaded');
      continue;
    }
    column.shines = reflectsOnWalls(room.reflections) && findColumnReflections(room);
    column.glows = glowsLightWalls ? findColumnGlows(room.glows) : 0;
    drawLitWallSlice(fb, room);
  }
}

/** Casts screen column `col` into `column`: what the ray hit, the rows its wall covers, and the z-buffer. */
function castColumnRay(fb: Framebuffer, { map, eye }: Room, col: number): void {
  const { width: w, height: h } = fb;
  const { dirX, dirY, planeX, planeY, proj, half } = view;
  const cameraX = (2 * col) / w - 1;
  const rayX = dirX + planeX * cameraX;
  const rayY = dirY + planeY * cameraX;
  castRay(map, eye.x, eye.y, rayX, rayY, hit);
  fb.zbuffer[col] = hit.distance;

  const wallHeightPx = hit.tile === 0 ? 0 : proj / hit.distance;
  const start = Math.max(0, Math.floor(half - wallHeightPx / 2));
  const end = Math.max(start, Math.min(h, Math.floor(half + wallHeightPx / 2)));
  wallStart[col] = start;
  wallEnd[col] = end;
  let texX = Math.floor(hit.wallX * TEX);
  if ((hit.side === X_SIDE && rayX > 0) || (hit.side === Y_SIDE && rayY < 0)) {
    texX = TEX - texX - 1;
  }
  column.col = col;
  column.start = start;
  column.end = end;
  column.wallHeightPx = wallHeightPx;
  column.tile = hit.tile;
  column.texX = texX;
  column.side = hit.side;
  column.rayX = rayX;
  column.rayY = rayY;
}

/** Which face of its tile the column's ray hit, where, and where that face's light is baked. */
function findColumnFace(room: LitRoom): void {
  const { rayX, rayY } = column;
  const { eye, lighting } = room;
  // FACE_NORMALS order: a ray heading +x hits a west face, one heading +y a north face.
  const face = hit.side === X_SIDE ? (rayX > 0 ? 0 : 1) : rayY > 0 ? 2 : 3;
  const faceOffset = lighting.faceOffset[(hit.mapY * room.map.width + hit.mapX) * 4 + face] as number;
  column.normal = FACE_NORMALS[face] as Normal;
  column.faceOffset = faceOffset;
  column.lightCol = faceOffset + Math.floor(hit.wallX * WALL_U) * WALL_V;
  column.hitX = eye.x + hit.distance * rayX;
  column.hitY = eye.y + hit.distance * rayY;
  column.distance = hit.distance;
}

/**
 * The lamps' reflections on the column into columnShine and columnShineLamp: at each of REFLECTION_SAMPLES heights,
 * the brightest of the lamps it can reflect, each one tried if it shows at its own bounce height (a soft spot face-on,
 * a streak towards the lamp seen along the wall). Per height, not one lamp per column: where one lamp's reflection
 * takes over from another's along a wall, a whole column switched lamps at once and left a seam. Returns whether
 * anything shows. It fades as the eye steps away from the wall itself (not its endless plane), with distance along it, and
 * in each lamp's shadow.
 */
function findColumnReflections(room: LitRoom): boolean {
  const { normal, faceOffset, hitX, hitY, tile } = column;
  const { lighting: lm, eye } = room;
  const away = distanceToWall(lm, faceOffset, normal, hitX, hitY, eye) / REFLECTION_NEAR;
  const far = column.distance / REFLECTION_RANGE;
  const fade = away < 1 && far < 1 ? (1 - away * away) * (1 - far * far) * 255 : 0;
  const material = REFLECTION_MATERIAL.at(tile);
  if (fade === 0 || !material) {
    return false;
  }
  const slot = (column.lightCol / WALL_V) * REFLECTION_LAMPS;
  const scale = fade * REFLECTION_STRENGTH;
  let shows = false;
  for (let k = 0; k < REFLECTION_LAMPS; k++) {
    const index = lm.wallLamp[slot + k] as number;
    const lamp = lm.lights.at(index);
    if (index < 0 || !lamp) {
      continue;
    }
    // Dimmed by how much of the lamp the column sees: a lamp half hidden by a door's edge reflects half as brightly.
    const strength = scale * ((lm.wallLampSeen[slot + k] as number) / 255);
    const bounce = bounceHeight(lamp, hitX, hitY, eye.x, eye.y);
    if (reflection(lamp, material, normal, hitX, hitY, bounce, eye, lamp.z) * strength < VISIBLE_SHINE) {
      continue;
    }
    if (!shows) {
      shows = true;
      columnShine.fill(0);
      columnShineLamp.fill(index);
    }
    for (let i = 0; i < REFLECTION_SAMPLES; i++) {
      const height = i / (REFLECTION_SAMPLES - 1);
      const shine = reflection(lamp, material, normal, hitX, hitY, height, eye, lamp.z) * strength;
      if (shine > (columnShine[i] as number)) {
        columnShine[i] = shine;
        columnShineLamp[i] = index;
      }
    }
  }
  return shows;
}

/** The avatars glowing on the column (near enough and in front of it), and their light up it. Returns how many. */
function findColumnGlows(glows: readonly Glow[]): number {
  const { normal, hitX, hitY } = column;
  let count = 0;
  for (const g of glows) {
    const dx = g.x - hitX;
    const dy = g.y - hitY;
    if (dx * normal.dx + dy * normal.dy > 0 && dx * dx + dy * dy < GLOW_RADIUS * GLOW_RADIUS) {
      columnGlows[count++] = g;
    }
  }
  if (count === 0) {
    return 0;
  }
  for (let j = 0; j < GLOW_HEIGHTS; j++) {
    const height = j / (GLOW_HEIGHTS - 1);
    let gr = 0;
    let gg = 0;
    let gb = 0;
    for (let k = 0; k < count; k++) {
      const glow = columnGlows[k] as Glow;
      const light = glowLight(glow, hitX, hitY, height, normal.dx, normal.dy, 0);
      gr += glow.r * light;
      gg += glow.g * light;
      gb += glow.b * light;
    }
    columnGlowLight[j * 3] = gr;
    columnGlowLight[j * 3 + 1] = gg;
    columnGlowLight[j * 3 + 2] = gb;
  }
  return count;
}

/**
 * Each texel lit by its baked light at its relief level or by the avatars' glow, whichever is brighter, plus the
 * lamps' reflection on it. Under the reflections alone, the reflection on black.
 */
function drawLitWallSlice(fb: Framebuffer, room: LitRoom): void {
  const { width: w, pixels } = fb;
  const { col, start, end, wallHeightPx, tile, texX, lightCol, shines, glows } = column;
  const { wall } = room.lighting;
  const colours = room.reflectionColours;
  const lit = lampsLightTheRoom(room.reflections);
  const tex = room.textures[tile] as Uint32Array;
  const relief = RELIEF[tile] as Uint8Array;
  const gloss = GLOSS[tile] as Uint8Array;
  const levels = RELIEF_LEVELS.length;
  const texelRowsToSampleRow = Math.log2(TEX / WALL_V);
  const lights = room.lighting.lights.length;
  const step = TEX / wallHeightPx;
  let texPos = (start - view.half + wallHeightPx / 2) * step;
  // A near wall shows each texel on many rows: shade it once and repeat it.
  let shadedY = -1;
  let shaded = 0;
  for (let y = start; y < end; y++) {
    // Clamped at the top as in the plain slice; −1 would also match shadedY's starting −1 and write the unset `shaded`.
    const texY = texPos < 0 ? 0 : Math.min(TEX - 1, texPos | 0);
    texPos += step;
    if (texY === shadedY) {
      pixels[y * w + col] = shaded;
      continue;
    }
    shadedY = texY;
    const t = texY * TEX + texX;
    const c = tex[t] as number;
    let r = 0;
    let g = 0;
    let b = 0;
    if (lit) {
      const baked = wall[(lightCol + (texY >> texelRowsToSampleRow)) * levels + (relief[t] as number)] as number;
      r = ((c & 0xff) * (baked & 0xff)) >> 7;
      g = (((c >>> 8) & 0xff) * ((baked >>> 8) & 0xff)) >> 7;
      b = (((c >>> 16) & 0xff) * ((baked >>> 16) & 0xff)) >> 7;
    }
    if (glows > 0) {
      // Blended between the two heights either side of this texel row.
      const at = (1 - (texY + 0.5) / TEX) * (GLOW_HEIGHTS - 1);
      const below = at | 0;
      const above = Math.min(below + 1, GLOW_HEIGHTS - 1);
      const k = at - below;
      const gr = (columnGlowLight[below * 3] as number) * (1 - k) + (columnGlowLight[above * 3] as number) * k;
      const gg = (columnGlowLight[below * 3 + 1] as number) * (1 - k) + (columnGlowLight[above * 3 + 1] as number) * k;
      const gb = (columnGlowLight[below * 3 + 2] as number) * (1 - k) + (columnGlowLight[above * 3 + 2] as number) * k;
      r = Math.max(r, ((c & 0xff) * gr) | 0);
      g = Math.max(g, (((c >>> 8) & 0xff) * gg) | 0);
      b = Math.max(b, (((c >>> 16) & 0xff) * gb) | 0);
    }
    if (shines && gloss[t] === 1) {
      // Blended between the two samples either side of this texel row, in the colour of the brighter one's lamp.
      const at = (1 - (texY + 0.5) / TEX) * (REFLECTION_SAMPLES - 1);
      const below = at | 0;
      const above = Math.min(below + 1, REFLECTION_SAMPLES - 1);
      const low = columnShine[below] as number;
      const high = columnShine[above] as number;
      const s = low + (high - low) * (at - below);
      const shine = (tile * lights + (columnShineLamp[low >= high ? below : above] as number)) * 3;
      r += (s * (colours[shine] as number)) | 0;
      g += (s * (colours[shine + 1] as number)) | 0;
      b += (s * (colours[shine + 2] as number)) | 0;
    }
    shaded = packClamped(r, g, b);
    pixels[y * w + col] = shaded;
  }
}

// Floor and ceiling.

/** The floor's and ceiling's colour per floor cell this frame, and what the floor sees of its lamps. */
function floorAndCeilingColours(room: LitRoom): FloorTables {
  const lm = room.lighting;
  if (!lampsLightTheRoom(room.reflections)) {
    return blackFloorAndCeiling(lm);
  }
  const shaded = room.objects.length > 0;
  const glowing = room.glows.length > 0;
  if (!shaded && !glowing) {
    return lm;
  }
  const t = putBackFrameTables(lm);
  if (shaded) {
    shadeFloor(lm, room.objects, FLOOR, t, inView);
  }
  if (glowing) {
    addGlow(lm, room.glows, t);
  }
  return t;
}

const inView = (x: number, y: number, reach: number) => !outOfView(x, y, reach);

function blackFloorAndCeiling(lm: Lighting): FloorTables {
  if (blackTables?.floorLampSeen !== lm.floorLampSeen) {
    const black = new Uint32Array(lm.floor.length).fill(BLACK);
    blackTables = { floor: black, ceiling: black, floorLampSeen: lm.floorLampSeen };
  }
  return blackTables;
}

/** The frame tables for `lm`, with last frame's patched cells put back. */
function putBackFrameTables(lm: Lighting): NonNullable<typeof frameTables> {
  if (frameTables?.lm !== lm) {
    const touched = new Uint8Array(lm.floor.length);
    const dirty = new Int32Array(lm.floor.length);
    const light = new Float32Array(lm.floor.length * 3);
    const t: NonNullable<typeof frameTables> = {
      lm,
      floor: lm.floor.slice(),
      ceiling: lm.ceiling.slice(),
      floorLampSeen: lm.floorLampSeen.slice(),
      touched,
      dirty,
      dirtyCount: 0,
      light,
      touch(i) {
        if (touched[i] === 0) {
          touched[i] = 1;
          dirty[t.dirtyCount++] = i;
          light.fill(0, i * 3, i * 3 + 3);
        }
      },
    };
    frameTables = t;
  }
  const t = frameTables;
  for (let j = 0; j < t.dirtyCount; j++) {
    const i = t.dirty[j] as number;
    t.floor[i] = lm.floor[i] as number;
    t.ceiling[i] = lm.ceiling[i] as number;
    const slots = i * REFLECTION_LAMPS;
    t.floorLampSeen.set(lm.floorLampSeen.subarray(slots, slots + REFLECTION_LAMPS), slots);
    t.touched[i] = 0;
  }
  t.dirtyCount = 0;
  return t;
}

/**
 * Each avatar in view lights the cells within its reach, √(GLOW_RADIUS² − ½²) of its disc. Glows add up, and a cell
 * takes their sum where it's brighter than its light, shadows included (see withGlow). The cost is the cells near
 * avatars in view, not the pixels showing them.
 *
 * The disc sits at eye height, half way between floor and ceiling, so the ceiling above a cell gets exactly the glow
 * its floor does: it is worked out once.
 */
function addGlow(lm: Lighting, glows: readonly Glow[], t: NonNullable<typeof frameTables>): void {
  const { stride, rows } = lm;
  const reach = Math.sqrt(GLOW_RADIUS * GLOW_RADIUS - EYE_HEIGHT * EYE_HEIGHT);
  const span = Math.ceil(reach * FLOOR_SUB);
  const cellsReach = ((span + 1) * Math.SQRT2) / FLOOR_SUB;
  for (const g of glows) {
    if (outOfView(g.x, g.y, cellsReach)) {
      continue;
    }
    const gx = Math.floor(g.x * FLOOR_SUB);
    const gy = Math.floor(g.y * FLOOR_SUB);
    for (let cy = Math.max(0, gy - span); cy <= Math.min(rows - 1, gy + span); cy++) {
      for (let cx = Math.max(0, gx - span); cx <= Math.min(stride - 1, gx + span); cx++) {
        const x = (cx + 0.5) / FLOOR_SUB;
        const y = (cy + 0.5) / FLOOR_SUB;
        const onFloor = glowLight(g, x, y, 0, 0, 0, 1);
        if (onFloor === 0) {
          continue;
        }
        const i = cy * stride + cx;
        t.touch(i);
        t.light[i * 3] = (t.light[i * 3] as number) + g.r * onFloor;
        t.light[i * 3 + 1] = (t.light[i * 3 + 1] as number) + g.g * onFloor;
        t.light[i * 3 + 2] = (t.light[i * 3 + 2] as number) + g.b * onFloor;
      }
    }
  }
  const l = t.light;
  for (let j = 0; j < t.dirtyCount; j++) {
    const i = t.dirty[j] as number;
    const r = l[i * 3] as number;
    const g = l[i * 3 + 1] as number;
    const b = l[i * 3 + 2] as number;
    t.floor[i] = withGlow(t.floor[i] as number, FLOOR, r, g, b);
    t.ceiling[i] = withGlow(t.ceiling[i] as number, CEILING, r, g, b);
  }
}

/** Whether everything within `reach` tiles of (x, y) lies behind the eye or past the left or right edge of the frame. */
function outOfView(x: number, y: number, reach: number): boolean {
  const ox = x - view.x;
  const oy = y - view.y;
  const depth = ox * view.dirX + oy * view.dirY;
  if (depth < -reach) {
    return true;
  }
  // The frame's edges run ±planeLen across per tile of depth.
  const planeLen = Math.sqrt(view.planeX * view.planeX + view.planeY * view.planeY);
  const across = (ox * view.planeX + oy * view.planeY) / planeLen;
  const pastEdge = (Math.abs(across) - planeLen * depth) / Math.sqrt(1 + planeLen * planeLen);
  return pastEdge > reach;
}

/**
 * Colour `c` of a surface of colour `albedo` also lit by glow light r, g, b: per channel, whichever is brighter, not
 * the sum. The avatars' glow shows in the dark and is lost under a lamp, as a screen's is.
 */
function withGlow(c: number, albedo: number, r: number, g: number, b: number): number {
  const rr = Math.min(255, Math.max(c & 0xff, ((albedo & 0xff) * r) | 0));
  const gg = Math.min(255, Math.max((c >>> 8) & 0xff, (((albedo >>> 8) & 0xff) * g) | 0));
  const bb = Math.min(255, Math.max((c >>> 16) & 0xff, (((albedo >>> 16) & 0xff) * b) | 0));
  return (0xff000000 | (bb << 16) | (gg << 8) | rr) >>> 0;
}

function packClamped(r: number, g: number, b: number): number {
  return (0xff000000 | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r)) >>> 0;
}

/** Each floor and ceiling pixel the walls leave, in its cell's colour. */
function drawFloorAndCeiling(fb: Framebuffer, room: LitRoom, floor: Uint32Array, ceiling: Uint32Array): void {
  const { width: w, height: h, pixels } = fb;
  const { stride, rows } = room.lighting;
  const lastCellX = stride - 1;
  const lastCellY = rows - 1;
  for (let y = 0; y < h; y++) {
    const above = y < view.half;
    const colours = above ? ceiling : floor;
    const { x: startX, y: startY, stepX, stepY } = aimFloorRow(room.eye, y, w);
    let fx = startX;
    let fy = startY;
    const row = y * w;
    for (let col = 0; col < w; col++, fx += stepX, fy += stepY) {
      if (above ? y >= (wallStart[col] as number) : y < (wallEnd[col] as number)) {
        continue;
      }
      // clampCell written out: called here, this loop measured 3% slower (bench:walls).
      let ix = fx | 0;
      let iy = fy | 0;
      if (ix < 0) {
        ix = 0;
      } else if (ix > lastCellX) {
        ix = lastCellX;
      }
      if (iy < 0) {
        iy = 0;
      } else if (iy > lastCellY) {
        iy = lastCellY;
      }
      pixels[row + col] = colours[iy * stride + ix] as number;
    }
  }
}

/** Aims floorRow at screen row `y`: along a row the floor point moves linearly, so it's stepped, not re-projected. */
function aimFloorRow(eye: PlayerState, y: number, w: number): FloorRow {
  const { dirX, dirY, planeX, planeY } = view;
  const d = rowDistance[y] as number;
  floorRow.x = eye.x * FLOOR_SUB + d * (dirX - planeX);
  floorRow.y = eye.y * FLOOR_SUB + d * (dirY - planeY);
  floorRow.stepX = (d * 2 * planeX) / w;
  floorRow.stepY = (d * 2 * planeY) / w;
  return floorRow;
}

/** A cell coordinate clamped to the lightmap, 0..last: guards rounding at the map's edge. */
const clampCell = (cell: number, last: number) => (cell < 0 ? 0 : cell > last ? last : cell);

/**
 * The lamps' reflections on the drawn floor, and their light off the floor on the ceiling: worked out every
 * FLOOR_REFLECTION_STEP_PX on every other row (reflectionAlongRow), blended between, and added where the cell sees the
 * lamp. It changes slowly down the screen, so the next row reuses it.
 */
function addFloorAndCeilingReflections(fb: Framebuffer, room: LitRoom, floorLampSeen: Uint8Array): void {
  const { width: w, height: h } = fb;
  const { half } = view;
  const floorTop = Math.ceil(half);
  let shows = false;
  for (let y = 0; y < h; y++) {
    const above = y < half;
    if ((above ? y : y - floorTop) % 2 === 0) {
      const inRange = (rowDistance[y] as number) / FLOOR_SUB < REFLECTION_RANGE;
      shows = inRange && reflectionAlongRow(room, aimFloorRow(room.eye, y, w), above ? 'ceiling' : 'floor');
    }
    if (shows) {
      addRowReflection(fb, room, y, floorLampSeen);
    }
  }
}

/**
 * The floor's reflection along `row`, every FLOOR_REFLECTION_STEP_PX, into rowShine and rowShineLamp. Returns whether
 * any of it shows. On the ceiling it's the lamps mirrored in the floor: the ceiling, the eye and those lamps mirrored
 * over the eye's height make the floor, the eye and lamps 1 + z high.
 */
function reflectionAlongRow(room: LitRoom, row: FloorRow, surface: 'floor' | 'ceiling'): boolean {
  const { lighting: lm, eye } = room;
  const { stride: across, rows: down } = lm;
  // In tiles: reflection() works in tiles, the floor row in lightmap cells.
  const x0 = row.x / FLOOR_SUB;
  const y0 = row.y / FLOOR_SUB;
  const dx = row.stepX / FLOOR_SUB;
  const dy = row.stepY / FLOOR_SUB;
  let shows = false;
  for (let i = 0; i < rowShine.length; i++) {
    const x = x0 + dx * i * FLOOR_REFLECTION_STEP_PX;
    const y = y0 + dy * i * FLOOR_REFLECTION_STEP_PX;
    const far2 = ((x - eye.x) ** 2 + (y - eye.y) ** 2) / (REFLECTION_RANGE * REFLECTION_RANGE);
    rowShine[i] = 0;
    const cx = Math.floor(x * FLOOR_SUB);
    const cy = Math.floor(y * FLOOR_SUB);
    if (far2 >= 1 || cx < 0 || cy < 0 || cx >= across || cy >= down) {
      continue;
    }
    const slot = (cy * across + cx) * REFLECTION_LAMPS;
    for (let k = 0; k < REFLECTION_LAMPS; k++) {
      const index = lm.floorLamp[slot + k] as number;
      const lamp = lm.lights.at(index);
      if (index < 0 || !lamp) {
        continue;
      }
      const lampZ = surface === 'ceiling' ? 1 + lamp.z : lamp.z;
      const shine =
        reflection(lamp, FLOOR_MATERIAL, FLOOR_NORMAL, x, y, 0, eye, lampZ) * (1 - far2) * FLOOR_SHINE_SCALE;
      if (shine > (rowShine[i] as number)) {
        rowShine[i] = shine;
        rowShineLamp[i] = index;
      }
    }
    shows ||= (rowShine[i] as number) >= VISIBLE_SHINE;
  }
  return shows;
}

/**
 * Adds row y's reflection (rowShine, blended between its samples; the ceiling's at CEILING_SHINE of it) to the floor
 * or ceiling drawn there, times how much of the lamp each pixel's own cell sees, so its shadow edge is the floor
 * light's. A span between two samples that both show nothing is skipped whole: the blend never exceeds its ends.
 */
function addRowReflection(fb: Framebuffer, room: LitRoom, y: number, floorSees: Uint8Array): void {
  const { width: w, pixels } = fb;
  const { stride, rows, floorLamp, lights } = room.lighting;
  const colours = room.reflectionColours;
  const floorTexture = room.textures.length;
  const above = y < view.half;
  const share = above ? CEILING_SHINE : 1;
  // Objects' shadows lie on the floor alone: the ceiling's light off the floor keeps the baked shares.
  const floorLampSeen = above ? room.lighting.floorLampSeen : floorSees;
  const { x: startX, y: startY, stepX, stepY } = aimFloorRow(room.eye, y, w);
  const lastCellX = stride - 1;
  const lastCellY = rows - 1;
  const row = y * w;
  for (let i = 0; i * FLOOR_REFLECTION_STEP_PX < w; i++) {
    const left = rowShine[i] as number;
    const right = rowShine[i + 1] as number;
    // A hair under the threshold, so the blend's rounding can't matter.
    if (share * Math.max(left, right) < VISIBLE_SHINE * 0.999) {
      continue;
    }
    const lamp = rowShineLamp[left >= right ? i : i + 1] as number;
    const colour = (floorTexture * lights.length + lamp) * 3;
    const first = i * FLOOR_REFLECTION_STEP_PX;
    const last = Math.min(w, first + FLOOR_REFLECTION_STEP_PX);
    for (let col = first; col < last; col++) {
      if (above ? y >= (wallStart[col] as number) : y < (wallEnd[col] as number)) {
        continue;
      }
      const blended = share * (left + (right - left) * ((col - first) / FLOOR_REFLECTION_STEP_PX));
      if (blended < VISIBLE_SHINE) {
        continue;
      }
      const cellX = clampCell((startX + stepX * col) | 0, lastCellX);
      const cellY = clampCell((startY + stepY * col) | 0, lastCellY);
      const cell = (cellY * stride + cellX) * REFLECTION_LAMPS;
      let seen = 0;
      for (let k = 0; k < REFLECTION_LAMPS; k++) {
        if (floorLamp[cell + k] === lamp) {
          seen = (floorLampSeen[cell + k] as number) / 255;
          break;
        }
      }
      if (seen === 0) {
        continue;
      }
      const s = blended * seen;
      const c = pixels[row + col] as number;
      pixels[row + col] = packClamped(
        (c & 0xff) + ((s * (colours[colour] as number)) | 0),
        ((c >>> 8) & 0xff) + ((s * (colours[colour + 1] as number)) | 0),
        ((c >>> 16) & 0xff) + ((s * (colours[colour + 2] as number)) | 0)
      );
    }
  }
}
