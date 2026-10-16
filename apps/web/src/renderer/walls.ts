// The ray-cast view: walls column by column, then floor and ceiling. Unlit, walls show their textures (y-side faces
// shaded) over a flat ceiling and floor. Lit (decision D24), each wall texel takes its baked light or the avatars'
// glow, whichever is brighter, plus the lamp reflection its column shows best; floor and ceiling go row by row (in
// memory order) from the baked colours (with the glow likewise), plus the lamps' reflections. Allocation-free per frame: scratch buffers are rebuilt only when the
// frame's size or FOV changes.
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
import { GLOSS, REFLECTION_MATERIAL, RELIEF, RELIEF_LEVELS, type ReflectionMaterial, TEX } from './textures';

/** The unlit ceiling's colour, and the colour the lit one is baked from. */
export const CEILING = rgb(0x38, 0x38, 0x38);
/** The unlit floor's colour, and the colour the lit one is baked from. */
export const FLOOR = rgb(0x70, 0x70, 0x70);
/** A smooth, semi-glossy floor: lamps smear along it towards you. */
const FLOOR_MATERIAL: ReflectionMaterial = { shininess: 16, f0: 0.1, tint: 0 };
/** Floor reflections are worked out every this many pixels along every other row, and blended between. */
const FLOOR_STEP = 16;
/**
 * The ceiling reflects the lamps' light off the floor, this much of what the floor reflects: each lamp mirrored in
 * the floor, as far under it as the lamp is over it. Only the lamps' light, never the floor, its walls or doorways.
 */
const CEILING_SHINE = 0.5;
/** A reflection under half a step of brightness (×255 scale) shows nothing, so it isn't drawn. */
const VISIBLE_SHINE = 0.5;
/** The floor's reflection scale: the eye is always half a tile off the floor's face (see REFLECTION_NEAR). */
const FLOOR_SHINE_SCALE = (() => {
  const near = 0.5 / REFLECTION_NEAR;
  return (1 - near * near) * 255 * REFLECTION_STRENGTH;
})();
/** Avatar glow is worked out at GLOW_HEIGHTS heights up a wall column, blended per texel row. */
const GLOW_HEIGHTS = 9;

/** The camera for the frame being drawn. */
const view = createView();
const hit = createRayHit();

/** Per-frame-size scratch for the lit renderer: rebuilt when the frame's size or FOV changes. */
let scratchSize = { width: 0, height: 0, fov: 0 };
/** Perpendicular floor / ceiling distance per screen row, pre-scaled to lightmap cells. */
let rowDist = new Float64Array(0);
/** Per screen column, the rows its wall covers, [start, end). */
let wallStart = new Int32Array(0);
let wallEnd = new Int32Array(0);
/**
 * A floor or ceiling row's reflection every FLOOR_STEP pixels (scaled, 0 where it doesn't show), and the lamp behind
 * each.
 */
let floorShine = new Float64Array(0);
let floorShineLamp = new Int32Array(0);

/**
 * Per texture × lamp, then the floor × lamp (as texture number textures.length): what one unit of that lamp's
 * reflection adds, r, g, b (see reflectedColour).
 */
let reflectedRgb = new Float64Array(0);
let reflectedRgbFor: { lm: Lighting; textures: Uint32Array[] } | null = null;
/** Opaque black, under the reflections alone. */
const BLACK = 0xff000000;
/** Black floor and ceiling colours, one per floor cell: rebuilt when a Lighting's floor has a new size. */
let blackTable = new Uint32Array(0);

/** The wall column being drawn: filled by castColumn, then aimReflection and gatherGlow, read by drawWallColumn. */
const column = {
  col: 0,
  /** Rows the wall covers, [start, end); equal when it shows none. */
  start: 0,
  end: 0,
  /** The wall's height on screen (px), its tile and the texture column it shows. */
  lineH: 0,
  tile: 0,
  texX: 0,
  /** The face's outward normal and its offset into the Lighting's tables (−1: no floor in front, so drawn unlit). */
  normal: FACE_NORMALS[0] as Normal,
  base: -1,
  /** The face's baked sample column: its offset into `wall`. */
  lightCol: 0,
  /** Where the ray hit (tiles) and how far off, perpendicular to the camera plane. */
  hitX: 0,
  hitY: 0,
  distance: 0,
  /** Whether a lamp's reflection shows on it: per height in `reflected`, with the lamp in `reflectedLamp`. */
  shines: false,
  /** How many avatars glow on it (the first of columnGlows); their light per height is in columnGlowLight. */
  glows: 0,
};
/** The column's reflection at REFLECTION_SAMPLES heights from the floor up, scaled, and the lamp it shows at each. */
const reflected = new Float64Array(REFLECTION_SAMPLES);
const reflectedLamp = new Int32Array(REFLECTION_SAMPLES);
/** The avatars glowing on the column, and their glow light, r, g, b, per height from the floor up. */
const columnGlows: Glow[] = [];
const columnGlowLight = new Float64Array(GLOW_HEIGHTS * 3);

/**
 * The floor and ceiling colours with this frame's avatar glow, per floor cell, copies of a Lighting's; the cells the
 * glow touched, put back from the Lighting's own next frame; and the glow light summed on each, floor r, g, b then
 * ceiling r, g, b.
 */
let glowTables: {
  lm: Lighting;
  floor: Uint32Array;
  ceiling: Uint32Array;
  touched: Uint8Array;
  dirty: number[];
  light: Float32Array;
} | null = null;

/**
 * Draws the view from `p` into `fb` and fills its z-buffer. With `lighting`, walls, floor and ceiling are lit, show
 * the lamps' reflections on the surfaces `reflections` picks, and the avatars' `glows`.
 */
export function renderWalls(
  fb: Framebuffer,
  map: GameMap,
  p: PlayerState,
  textures: Uint32Array[],
  lighting: Lighting | null = null,
  reflections: ReflectionMode = 'both',
  glows: readonly Glow[] = []
): void {
  setView(view, fb, p);
  if (lighting) {
    renderLitWalls(fb, map, p, textures, lighting, reflections, glows);
    return;
  }
  const { width: w, height: h, pixels, zbuffer } = fb;
  const { dirX, dirY, planeX, planeY, proj, half } = view;
  const size = TEX;

  for (let col = 0; col < w; col++) {
    const cameraX = (2 * col) / w - 1;
    const rayX = dirX + planeX * cameraX;
    const rayY = dirY + planeY * cameraX;
    castRay(map, p.x, p.y, rayX, rayY, hit);
    zbuffer[col] = hit.distance;

    const lineH = hit.tile === 0 ? 0 : proj / hit.distance;
    const start = Math.max(0, Math.floor(half - lineH / 2));
    const end = Math.min(h, Math.floor(half + lineH / 2));

    for (let y = 0; y < start; y++) {
      pixels[y * w + col] = CEILING;
    }
    if (end > start) {
      const tex = textures[hit.tile] as Uint32Array;
      let texX = Math.floor(hit.wallX * size);
      if ((hit.side === 0 && rayX > 0) || (hit.side === 1 && rayY < 0)) {
        texX = size - texX - 1;
      }
      const step = size / lineH;
      let texPos = (start - half + lineH / 2) * step;
      for (let y = start; y < end; y++) {
        // A wall under a texture's height steps over a texel per row, so its top row can start over a texel above
        // the texture (texPos < −1): it shows the top texel.
        const texY = texPos < 0 ? 0 : Math.min(size - 1, texPos | 0);
        texPos += step;
        const c = tex[texY * size + texX] as number;
        // SIDE_SHADE (lighting.ts) as a literal: read from the constant, this loop measured 3% slower (bench:walls).
        pixels[y * w + col] = hit.side === 1 ? scaleRgb(c, 0.7) : c;
      }
    }
    for (let y = Math.max(end, start); y < h; y++) {
      pixels[y * w + col] = FLOOR;
    }
  }
}

/** Walls column by column (cast, reflection, glow, draw), then floor and ceiling row by row. */
function renderLitWalls(
  fb: Framebuffer,
  map: GameMap,
  p: PlayerState,
  textures: Uint32Array[],
  lm: Lighting,
  reflections: ReflectionMode,
  glows: readonly Glow[]
): void {
  fitScratch(fb);
  /** False for the reflections alone: no baked light and no glow under them. */
  const direct = reflections !== 'only';
  // The avatars' glow is added into the floor and ceiling colours, per cell, before the floor loop reads them.
  const { floor, ceiling } = !direct ? blackTables(lm) : glows.length > 0 ? glowingTables(lm, glows) : lm;
  const colours = reflectedRgbTable(textures, lm);
  for (let col = 0; col < fb.width; col++) {
    castColumn(fb, map, p, lm, col);
    if (column.end === column.start) {
      continue;
    }
    if (column.base < 0) {
      drawUnlitColumn(fb, textures);
      continue;
    }
    column.shines = reflections !== 'none' && aimReflection(lm, p);
    column.glows = direct && glows.length > 0 ? gatherGlow(glows) : 0;
    drawWallColumn(fb, lm, textures, colours, direct);
  }
  drawFloorAndCeiling(fb, p, lm, floor, ceiling);
  if (reflections === 'both' || reflections === 'only') {
    shineFloorAndCeiling(fb, p, lm, colours, textures.length);
  }
}

/** Rebuilds the scratch buffers for this frame's size and FOV, if they changed. Needs setView first. */
function fitScratch(fb: Framebuffer): void {
  const { width: w, height: h, fov } = fb;
  if (scratchSize.width === w && scratchSize.height === h && scratchSize.fov === fov) {
    return;
  }
  const { proj, half } = view;
  rowDist = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    // Floor and ceiling are 0.5 below / above the eye; distances are pre-scaled to lightmap cells.
    rowDist[y] = ((0.5 * proj) / Math.abs(y + 0.5 - half)) * FLOOR_SUB;
  }
  wallStart = new Int32Array(w);
  wallEnd = new Int32Array(w);
  floorShine = new Float64Array(Math.ceil(w / FLOOR_STEP) + 1);
  floorShineLamp = new Int32Array(floorShine.length);
  scratchSize = { width: w, height: h, fov };
}

/** Black floor and ceiling tables the size of `lm`'s, for the reflections alone. */
function blackTables(lm: Lighting): { floor: Uint32Array; ceiling: Uint32Array } {
  if (blackTable.length !== lm.floor.length) {
    blackTable = new Uint32Array(lm.floor.length).fill(BLACK);
  }
  return { floor: blackTable, ceiling: blackTable };
}

/**
 * reflectedRgb for these textures and lamps, worked out from each texture's average shiny texel the first time they're
 * drawn together: OKLab per texel row would cost too much, and a texture's texels share a hue.
 */
function reflectedRgbTable(textures: Uint32Array[], lm: Lighting): Float64Array {
  if (reflectedRgbFor?.lm === lm && reflectedRgbFor.textures === textures) {
    return reflectedRgb;
  }
  const lights = lm.lights.length;
  reflectedRgb = new Float64Array((textures.length + 1) * lights * 3);
  const floor = [FLOOR & 0xff, (FLOOR >>> 8) & 0xff, (FLOOR >>> 16) & 0xff] as const;
  lm.lights.forEach((l, i) => {
    reflectedRgb.set(reflectedColour(floor, l, FLOOR_MATERIAL.tint), (textures.length * lights + i) * 3);
  });
  textures.forEach((tex, tile) => {
    const gloss = GLOSS[tile];
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
    const tint = REFLECTION_MATERIAL.at(tile)?.tint ?? 0;
    const mean = [sr / (n || 1), sg / (n || 1), sb / (n || 1)] as const;
    lm.lights.forEach((l, i) => {
      reflectedRgb.set(reflectedColour(mean, l, tint), (tile * lights + i) * 3);
    });
  });
  reflectedRgbFor = { lm, textures };
  return reflectedRgb;
}

/**
 * The floor and ceiling colours (one per floor cell, like the Lighting's) with the avatars' glow: last frame's cells
 * are put back, then each avatar lights the cells within its reach, √(GLOW_RADIUS² − ½²) of its disc. Glows add up,
 * and a cell takes their sum where it's brighter than its baked light (see withGlow). The cost is the cells near
 * avatars, not the pixels showing them; the floor loop reads these as it reads the Lighting's.
 */
function glowingTables(lm: Lighting, glows: readonly Glow[]): { floor: Uint32Array; ceiling: Uint32Array } {
  if (glowTables?.lm !== lm) {
    glowTables = {
      lm,
      floor: lm.floor.slice(),
      ceiling: lm.ceiling.slice(),
      touched: new Uint8Array(lm.floor.length),
      dirty: [],
      light: new Float32Array(lm.floor.length * 6),
    };
  }
  const t = glowTables;
  for (const i of t.dirty) {
    t.floor[i] = lm.floor[i] as number;
    t.ceiling[i] = lm.ceiling[i] as number;
    t.touched[i] = 0;
  }
  t.dirty.length = 0;
  const { stride, rows } = lm;
  const reach = Math.sqrt(GLOW_RADIUS * GLOW_RADIUS - EYE_HEIGHT * EYE_HEIGHT);
  const span = Math.ceil(reach * FLOOR_SUB);
  for (const g of glows) {
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
        if (t.touched[i] === 0) {
          t.touched[i] = 1;
          t.dirty.push(i);
          t.light.fill(0, i * 6, i * 6 + 6);
        }
        const onCeiling = glowLight(g, x, y, 1, 0, 0, -1);
        t.light[i * 6] = (t.light[i * 6] as number) + g.r * onFloor;
        t.light[i * 6 + 1] = (t.light[i * 6 + 1] as number) + g.g * onFloor;
        t.light[i * 6 + 2] = (t.light[i * 6 + 2] as number) + g.b * onFloor;
        t.light[i * 6 + 3] = (t.light[i * 6 + 3] as number) + g.r * onCeiling;
        t.light[i * 6 + 4] = (t.light[i * 6 + 4] as number) + g.g * onCeiling;
        t.light[i * 6 + 5] = (t.light[i * 6 + 5] as number) + g.b * onCeiling;
      }
    }
  }
  const l = t.light;
  for (const i of t.dirty) {
    t.floor[i] = withGlow(
      lm.floor[i] as number,
      FLOOR,
      l[i * 6] as number,
      l[i * 6 + 1] as number,
      l[i * 6 + 2] as number
    );
    t.ceiling[i] = withGlow(
      lm.ceiling[i] as number,
      CEILING,
      l[i * 6 + 3] as number,
      l[i * 6 + 4] as number,
      l[i * 6 + 5] as number
    );
  }
  return t;
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

/** Packs r, g, b (0 and up) as an opaque colour, each clamped to 255. */
function packClamped(r: number, g: number, b: number): number {
  return (0xff000000 | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r)) >>> 0;
}

// Wall columns.

/** Casts screen column `col` and fills `column` with what it hit, the z-buffer and the wall's rows. */
function castColumn(fb: Framebuffer, map: GameMap, p: PlayerState, lm: Lighting, col: number): void {
  const { width: w, height: h } = fb;
  const { dirX, dirY, planeX, planeY, proj, half } = view;
  const cameraX = (2 * col) / w - 1;
  const rayX = dirX + planeX * cameraX;
  const rayY = dirY + planeY * cameraX;
  castRay(map, p.x, p.y, rayX, rayY, hit);
  fb.zbuffer[col] = hit.distance;

  const lineH = hit.tile === 0 ? 0 : proj / hit.distance;
  const start = Math.max(0, Math.floor(half - lineH / 2));
  const end = Math.max(start, Math.min(h, Math.floor(half + lineH / 2)));
  wallStart[col] = start;
  wallEnd[col] = end;
  column.col = col;
  column.start = start;
  column.end = end;
  if (end === start) {
    return;
  }
  let texX = Math.floor(hit.wallX * TEX);
  if ((hit.side === 0 && rayX > 0) || (hit.side === 1 && rayY < 0)) {
    texX = TEX - texX - 1;
  }
  // FACE_NORMALS order: a ray heading +x hits a west face, one heading +y a north face.
  const face = hit.side === 0 ? (rayX > 0 ? 0 : 1) : rayY > 0 ? 2 : 3;
  const base = lm.faceOffset[(hit.mapY * map.width + hit.mapX) * 4 + face] as number;
  column.lineH = lineH;
  column.tile = hit.tile;
  column.texX = texX;
  column.normal = FACE_NORMALS[face] as Normal;
  column.base = base;
  column.lightCol = base + Math.floor(hit.wallX * WALL_U) * WALL_V;
  column.hitX = p.x + hit.distance * rayX;
  column.hitY = p.y + hit.distance * rayY;
  column.distance = hit.distance;
}

/**
 * The lamps' reflections on the column into `reflected` and `reflectedLamp`: at each of REFLECTION_SAMPLES heights, the
 * brightest of the lamps it can reflect, each one tried if it shows at its own bounce height (a soft spot face-on, a
 * streak towards the lamp seen along the wall). Per height, not one lamp per column: where one lamp's reflection takes
 * over from another's along a wall, a whole column switched lamps at once and left a seam. Returns whether anything
 * shows. It fades as you step away from the wall itself (not its endless plane), with distance along it, and in each
 * lamp's shadow.
 */
function aimReflection(lm: Lighting, p: PlayerState): boolean {
  const { normal, base, hitX, hitY, tile } = column;
  const away = distanceToWall(lm, base, normal, hitX, hitY, p) / REFLECTION_NEAR;
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
    const z = bounceHeight(lamp, hitX, hitY, p.x, p.y);
    if (reflection(lamp, material, normal, hitX, hitY, z, p, lamp.z) * strength < VISIBLE_SHINE) {
      continue;
    }
    if (!shows) {
      shows = true;
      reflected.fill(0);
      reflectedLamp.fill(index);
    }
    for (let i = 0; i < REFLECTION_SAMPLES; i++) {
      const height = i / (REFLECTION_SAMPLES - 1);
      const shine = reflection(lamp, material, normal, hitX, hitY, height, p, lamp.z) * strength;
      if (shine > (reflected[i] as number)) {
        reflected[i] = shine;
        reflectedLamp[i] = index;
      }
    }
  }
  return shows;
}

/**
 * The avatars glowing on the column (close enough and in front of it) into columnGlows, and their light at
 * GLOW_HEIGHTS heights into columnGlowLight. Returns how many.
 */
function gatherGlow(glows: readonly Glow[]): number {
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
    const z = j / (GLOW_HEIGHTS - 1);
    let gr = 0;
    let gg = 0;
    let gb = 0;
    for (let k = 0; k < count; k++) {
      const glow = columnGlows[k] as Glow;
      const light = glowLight(glow, hitX, hitY, z, normal.dx, normal.dy, 0);
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

/** A face with no floor in front can't be seen; this only guards rounding at the map edge. Plain texels. */
function drawUnlitColumn(fb: Framebuffer, textures: Uint32Array[]): void {
  const { width: w, pixels } = fb;
  const { col, start, end, lineH, tile, texX } = column;
  const tex = textures[tile] as Uint32Array;
  const step = TEX / lineH;
  let texPos = (start - view.half + lineH / 2) * step;
  let shadedY = -1;
  let shaded = 0;
  for (let y = start; y < end; y++) {
    const texY = texPos < 0 ? 0 : Math.min(TEX - 1, texPos | 0);
    texPos += step;
    if (texY !== shadedY) {
      shadedY = texY;
      shaded = tex[texY * TEX + texX] as number;
    }
    pixels[y * w + col] = shaded;
  }
}

/**
 * Draws the column: each texel lit by its baked light at its relief level or the avatars' glow, whichever is brighter,
 * plus the lamp's reflection. Without `direct` light, the reflection alone on black.
 */
function drawWallColumn(
  fb: Framebuffer,
  lm: Lighting,
  textures: Uint32Array[],
  colours: Float64Array,
  direct: boolean
): void {
  const { width: w, pixels } = fb;
  const { col, start, end, lineH, tile, texX, lightCol, shines, glows } = column;
  const size = TEX;
  const { wall } = lm;
  const tex = textures[tile] as Uint32Array;
  const relief = RELIEF[tile] as Uint8Array;
  const gloss = GLOSS[tile] as Uint8Array;
  const levels = RELIEF_LEVELS.length;
  const vShift = Math.log2(size / WALL_V);
  const lights = lm.lights.length;
  const step = size / lineH;
  let texPos = (start - view.half + lineH / 2) * step;
  // A near wall spreads each texel over several rows: shade it once and repeat it.
  let shadedY = -1;
  let shaded = 0;
  for (let y = start; y < end; y++) {
    // Clamped at the top as in the unlit loop; −1 would also match shadedY's starting −1 and write the unset `shaded`.
    const texY = texPos < 0 ? 0 : Math.min(size - 1, texPos | 0);
    texPos += step;
    if (texY === shadedY) {
      pixels[y * w + col] = shaded;
      continue;
    }
    shadedY = texY;
    const t = texY * size + texX;
    const c = tex[t] as number;
    let r = 0;
    let g = 0;
    let b = 0;
    if (direct) {
      // The baked light for this sample at this texel's relief level.
      const l = wall[(lightCol + (texY >> vShift)) * levels + (relief[t] as number)] as number;
      r = ((c & 0xff) * (l & 0xff)) >> 7;
      g = (((c >>> 8) & 0xff) * ((l >>> 8) & 0xff)) >> 7;
      b = (((c >>> 16) & 0xff) * ((l >>> 16) & 0xff)) >> 7;
    }
    if (glows > 0) {
      // The glow lights the texel if it's brighter than the baked light (blending the two heights either side of
      // this texel row); the lamps' reflection adds on top.
      const at = (1 - (texY + 0.5) / size) * (GLOW_HEIGHTS - 1);
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
      // Blend the two samples either side of this texel row's height, in the colour of the brighter one's lamp.
      const at = (1 - (texY + 0.5) / size) * (REFLECTION_SAMPLES - 1);
      const below = at | 0;
      const above = Math.min(below + 1, REFLECTION_SAMPLES - 1);
      const low = reflected[below] as number;
      const high = reflected[above] as number;
      const s = low + (high - low) * (at - below);
      const shine = (tile * lights + (reflectedLamp[low >= high ? below : above] as number)) * 3;
      r += (s * (colours[shine] as number)) | 0;
      g += (s * (colours[shine + 1] as number)) | 0;
      b += (s * (colours[shine + 2] as number)) | 0;
    }
    shaded = packClamped(r, g, b);
    pixels[y * w + col] = shaded;
  }
}

// Floor and ceiling.

/**
 * Floor and ceiling from their baked colours (with the avatars' glow), row by row: along a row the cast point moves
 * linearly, so it's stepped instead of re-projected.
 */
function drawFloorAndCeiling(
  fb: Framebuffer,
  p: PlayerState,
  lm: Lighting,
  floor: Uint32Array,
  ceiling: Uint32Array
): void {
  const { width: w, height: h, pixels } = fb;
  const { dirX, dirY, planeX, planeY, half } = view;
  const { stride, rows } = lm;
  const px = p.x * FLOOR_SUB;
  const py = p.y * FLOOR_SUB;
  const maxX = stride - 1;
  const maxY = rows - 1;
  for (let y = 0; y < h; y++) {
    const d = rowDist[y] as number;
    const above = y < half;
    const table = above ? ceiling : floor;
    let fx = px + d * (dirX - planeX);
    let fy = py + d * (dirY - planeY);
    const sx = (d * 2 * planeX) / w;
    const sy = (d * 2 * planeY) / w;
    const row = y * w;
    for (let col = 0; col < w; col++, fx += sx, fy += sy) {
      if (above ? y >= (wallStart[col] as number) : y < (wallEnd[col] as number)) {
        continue;
      }
      let ix = fx | 0;
      let iy = fy | 0;
      if (ix < 0) {
        ix = 0;
      } else if (ix > maxX) {
        ix = maxX;
      }
      if (iy < 0) {
        iy = 0;
      } else if (iy > maxY) {
        iy = maxY;
      }
      pixels[row + col] = table[iy * stride + ix] as number;
    }
  }
}

/**
 * The lamps' reflections on the drawn floor, and their light off the floor on the ceiling: worked out every
 * FLOOR_STEP pixels on every other row (shineFloorRow), blended between, and added where the cell sees the lamp.
 * It changes slowly down the screen, so the next row reuses it.
 */
function shineFloorAndCeiling(
  fb: Framebuffer,
  p: PlayerState,
  lm: Lighting,
  colours: Float64Array,
  floorTile: number
): void {
  const { width: w, height: h } = fb;
  const { dirX, dirY, planeX, planeY, half } = view;
  const floorTop = Math.ceil(half);
  let shows = false;
  for (let y = 0; y < h; y++) {
    const d = rowDist[y] as number;
    const above = y < half;
    if ((above ? y : y - floorTop) % 2 === 0) {
      const sx = (d * 2 * planeX) / w;
      const sy = (d * 2 * planeY) / w;
      const fx = p.x * FLOOR_SUB + d * (dirX - planeX);
      const fy = p.y * FLOOR_SUB + d * (dirY - planeY);
      const sub = FLOOR_SUB;
      shows = d / sub < REFLECTION_RANGE && shineFloorRow(lm, p, fx / sub, fy / sub, sx / sub, sy / sub, above);
    }
    if (shows) {
      shineRow(fb, p, lm, colours, floorTile, y);
    }
  }
}

/**
 * Works out the floor's reflection along one screen row, every FLOOR_STEP pixels, into floorShine and floorShineLamp:
 * the row's floor point at pixel col is (x0 + dx·col, y0 + dy·col) in tiles. Returns whether any of it shows. For a
 * `ceiling` row, the ceiling's reflection of the lamps mirrored in the floor: the ceiling, the eye and those lamps
 * mirrored over the eye's height make the floor, the eye and lamps 1 + z high.
 */
function shineFloorRow(
  lm: Lighting,
  p: PlayerState,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  ceiling: boolean
): boolean {
  const { stride: across, rows: down } = lm;
  let shows = false;
  for (let i = 0; i < floorShine.length; i++) {
    const x = x0 + dx * i * FLOOR_STEP;
    const y = y0 + dy * i * FLOOR_STEP;
    const far2 = ((x - p.x) ** 2 + (y - p.y) ** 2) / (REFLECTION_RANGE * REFLECTION_RANGE);
    floorShine[i] = 0;
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
      const lampZ = ceiling ? 1 + lamp.z : lamp.z;
      const shine = reflection(lamp, FLOOR_MATERIAL, FLOOR_NORMAL, x, y, 0, p, lampZ) * (1 - far2) * FLOOR_SHINE_SCALE;
      if (shine > (floorShine[i] as number)) {
        floorShine[i] = shine;
        floorShineLamp[i] = index;
      }
    }
    shows ||= (floorShine[i] as number) >= VISIBLE_SHINE;
  }
  return shows;
}

/**
 * Adds row y's reflection (floorShine, blended between its samples; the ceiling's at CEILING_SHINE of it) to the
 * floor or ceiling drawn there, times how much of the lamp each pixel's own cell sees, so its shadow edge is the
 * floor light's. A span between two samples that both show nothing is skipped whole: the blend never exceeds its ends.
 */
function shineRow(
  fb: Framebuffer,
  p: PlayerState,
  lm: Lighting,
  colours: Float64Array,
  floorTile: number,
  y: number
): void {
  const { width: w, pixels } = fb;
  const { dirX, dirY, planeX, planeY, half } = view;
  const { stride, rows, floorLamp, floorLampSeen } = lm;
  const above = y < half;
  const share = above ? CEILING_SHINE : 1;
  const d = rowDist[y] as number;
  const fx = p.x * FLOOR_SUB + d * (dirX - planeX);
  const fy = p.y * FLOOR_SUB + d * (dirY - planeY);
  const sx = (d * 2 * planeX) / w;
  const sy = (d * 2 * planeY) / w;
  const maxX = stride - 1;
  const maxY = rows - 1;
  const row = y * w;
  for (let i = 0; i * FLOOR_STEP < w; i++) {
    const left = floorShine[i] as number;
    const right = floorShine[i + 1] as number;
    // A hair under the threshold, so the blend's rounding can't matter.
    if (share * Math.max(left, right) < VISIBLE_SHINE * 0.999) {
      continue;
    }
    const lamp = floorShineLamp[left >= right ? i : i + 1] as number;
    const colour = (floorTile * lm.lights.length + lamp) * 3;
    const first = i * FLOOR_STEP;
    const last = Math.min(w, first + FLOOR_STEP);
    for (let col = first; col < last; col++) {
      if (above ? y >= (wallStart[col] as number) : y < (wallEnd[col] as number)) {
        continue;
      }
      const blended = share * (left + (right - left) * ((col - first) / FLOOR_STEP));
      if (blended < VISIBLE_SHINE) {
        continue;
      }
      let ix = (fx + sx * col) | 0;
      let iy = (fy + sy * col) | 0;
      if (ix < 0) {
        ix = 0;
      } else if (ix > maxX) {
        ix = maxX;
      }
      if (iy < 0) {
        iy = 0;
      } else if (iy > maxY) {
        iy = maxY;
      }
      const cell = (iy * stride + ix) * REFLECTION_LAMPS;
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
