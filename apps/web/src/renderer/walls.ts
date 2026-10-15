// Column-by-column textured wall renderer with flat ceiling and floor.
import { castRay, createRayHit, type GameMap, type PlayerState } from '@zoom3d/shared';
import { EYE_HEIGHT } from './camera';
import { reflectedColour } from './colour';
import { type Framebuffer, rgb } from './framebuffer';
import { GLOW_RADIUS, type Glow, glowLight } from './glow';
import {
  brightestReflection,
  distanceToWall,
  FACES,
  FLOOR_SUB,
  type Lighting,
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

export const CEILING = rgb(0x38, 0x38, 0x38);
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

const hit = createRayHit();
/** Perpendicular floor / ceiling distance per screen row (lighting only), refilled when the frame changes. */
let rowDist = new Float64Array(0);
let rowDistFor = '';
let wallStart = new Int32Array(0);
let wallEnd = new Int32Array(0);
/**
 * Per texture × lamp, then the floor × lamp (as texture number textures.length): what one unit of that lamp's
 * reflection adds, r, g, b (see reflectedColour).
 */
let reflectedRgb = new Float64Array(0);
let reflectedRgbFor: { lm: Lighting; textures: Uint32Array[] } | null = null;
/** The column's peak reflection, then its reflection at REFLECTION_SAMPLES heights from the floor up, scaled. */
const peak = new Float64Array(1);
const reflected = new Float64Array(REFLECTION_SAMPLES);
/** A floor row's reflection every FLOOR_STEP pixels (scaled, 0 where it doesn't show) and the lamp behind each. */
let floorShine = new Float64Array(0);
/** Avatar glow is worked out at GLOW_HEIGHTS heights up a wall column, blended per texel row. */
const GLOW_HEIGHTS = 9;
/** The avatars glowing on the wall column being drawn, and its glow light, r, g, b, per height from the floor up. */
const columnGlows: Glow[] = [];
let columnGlowCount = 0;
const columnGlowLight = new Float64Array(GLOW_HEIGHTS * 3);
/**
 * The floor and ceiling colours with this frame's avatar glow added, per floor cell, copies of a Lighting's; and the
 * cells the glow touched, put back from the Lighting's own next frame.
 */
let glowTables: {
  lm: Lighting;
  floor: Uint32Array;
  ceiling: Uint32Array;
  touched: Uint8Array;
  dirty: number[];
} | null = null;
let floorShineLamp = new Int32Array(0);

/** Darkens a colour to 70% (y-side walls), keeping alpha. */
export function shade(c: number): number {
  const r = ((c & 0xff) * 0.7) | 0;
  const g = (((c >>> 8) & 0xff) * 0.7) | 0;
  const b = (((c >>> 16) & 0xff) * 0.7) | 0;
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

export function renderWalls(
  fb: Framebuffer,
  map: GameMap,
  p: PlayerState,
  textures: Uint32Array[],
  lighting: Lighting | null = null,
  reflections: ReflectionMode = 'both',
  glows: readonly Glow[] = []
): void {
  if (lighting) {
    renderLitWalls(fb, map, p, textures, lighting, reflections, glows);
    return;
  }
  const { width: w, height: h, pixels, zbuffer } = fb;
  const dirX = Math.cos(p.angle);
  const dirY = Math.sin(p.angle);
  const planeLen = Math.tan(fb.fov / 2);
  // Camera plane points to the right of facing: (-sin, cos) in y-down coordinates.
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  const proj = w / 2 / planeLen;
  const half = h / 2;
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
        const texY = Math.min(size - 1, texPos | 0);
        texPos += step;
        const c = tex[texY * size + texX] as number;
        pixels[y * w + col] = hit.side === 1 ? shade(c) : c;
      }
    }
    for (let y = Math.max(end, start); y < h; y++) {
      pixels[y * w + col] = FLOOR;
    }
  }
}

/** SPIKE: renderWalls with baked lights. Walls go column by column; floor and ceiling then row by row (in memory order). */
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
 * The floor's reflection at column `col` of the row shineFloorRow worked out, `share` of it added to `c`: blended
 * between its samples, times how much of the lamp this very floor cell (at `cell` in floorLamp) sees, so its shadow
 * edge is the floor light's.
 */
function shineFloorPixel(
  lm: Lighting,
  c: number,
  col: number,
  cell: number,
  colours: Float64Array,
  floorTile: number,
  share: number
): number {
  const i = (col / FLOOR_STEP) | 0;
  const left = floorShine[i] as number;
  const right = floorShine[i + 1] as number;
  let s = share * (left + (right - left) * ((col - i * FLOOR_STEP) / FLOOR_STEP));
  if (s < 0.5) {
    return c;
  }
  const lamp = floorShineLamp[left >= right ? i : i + 1] as number;
  let seen = 0;
  for (let k = 0; k < REFLECTION_LAMPS; k++) {
    if (lm.floorLamp[cell + k] === lamp) {
      seen = (lm.floorLampSeen[cell + k] as number) / 255;
      break;
    }
  }
  if (seen === 0) {
    return c;
  }
  s *= seen;
  const colour = (floorTile * lm.lights.length + lamp) * 3;
  const r = Math.min(255, (c & 0xff) + ((s * (colours[colour] as number)) | 0));
  const g = Math.min(255, ((c >>> 8) & 0xff) + ((s * (colours[colour + 1] as number)) | 0));
  const b = Math.min(255, ((c >>> 16) & 0xff) + ((s * (colours[colour + 2] as number)) | 0));
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * The floor and ceiling colours (one per floor cell, like the Lighting's) with the avatars' glow added: last frame's
 * cells are put back, then each avatar lights the cells within its reach, √(GLOW_RADIUS² − ½²) of its disc. The cost
 * is the cells near avatars, not the pixels showing them; the floor loop reads these as it reads the Lighting's.
 */
function glowingTables(lm: Lighting, glows: readonly Glow[]): { floor: Uint32Array; ceiling: Uint32Array } {
  if (glowTables?.lm !== lm) {
    glowTables = {
      lm,
      floor: lm.floor.slice(),
      ceiling: lm.ceiling.slice(),
      touched: new Uint8Array(lm.floor.length),
      dirty: [],
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
        }
        t.floor[i] = addGlow(t.floor[i] as number, FLOOR, g, onFloor);
        t.ceiling[i] = addGlow(t.ceiling[i] as number, CEILING, g, glowLight(g, x, y, 1, 0, 0, -1));
      }
    }
  }
  return t;
}

/** Colour `c` with glow `g`, reaching it at strength k (see glowLight), on a surface of colour `albedo` added. */
function addGlow(c: number, albedo: number, g: Glow, k: number): number {
  const r = Math.min(255, (c & 0xff) + (((albedo & 0xff) * g.r * k) | 0));
  const gg = Math.min(255, ((c >>> 8) & 0xff) + ((((albedo >>> 8) & 0xff) * g.g * k) | 0));
  const b = Math.min(255, ((c >>> 16) & 0xff) + ((((albedo >>> 16) & 0xff) * g.b * k) | 0));
  return (0xff000000 | (b << 16) | (gg << 8) | r) >>> 0;
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
  const { shininess, f0 } = FLOOR_MATERIAL;
  // The eye is always half a tile off the floor's face.
  const near = 0.5 / REFLECTION_NEAR;
  const scale = (1 - near * near) * 255 * REFLECTION_STRENGTH;
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
      const shine =
        reflection(lamp, shininess, f0, 0, 0, 1, x, y, 0, p.x, p.y, ceiling ? 1 + lamp.z : lamp.z) * (1 - far2) * scale;
      if (shine > (floorShine[i] as number)) {
        floorShine[i] = shine;
        floorShineLamp[i] = index;
      }
    }
    shows ||= (floorShine[i] as number) >= 0.5;
  }
  return shows;
}

function renderLitWalls(
  fb: Framebuffer,
  map: GameMap,
  p: PlayerState,
  textures: Uint32Array[],
  lm: Lighting,
  reflections: ReflectionMode,
  glows: readonly Glow[]
): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const dirX = Math.cos(p.angle);
  const dirY = Math.sin(p.angle);
  const planeLen = Math.tan(fb.fov / 2);
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  const proj = w / 2 / planeLen;
  const half = h / 2;
  const size = TEX;
  const sub = FLOOR_SUB;
  const key = `${w}x${h}@${fb.fov}`;
  if (rowDistFor !== key) {
    rowDist = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      // Floor and ceiling are 0.5 below / above the eye; distances are pre-scaled to lightmap cells.
      rowDist[y] = ((0.5 * proj) / Math.abs(y + 0.5 - half)) * sub;
    }
    wallStart = new Int32Array(w);
    wallEnd = new Int32Array(w);
    floorShine = new Float64Array(Math.ceil(w / FLOOR_STEP) + 1);
    floorShineLamp = new Int32Array(floorShine.length);
    rowDistFor = key;
  }
  const { faceOffset, wall, stride, rows } = lm;
  // The avatars' glow is added into the floor and ceiling colours, per cell, before the floor loop reads them.
  const { floor, ceiling } = glows.length > 0 ? glowingTables(lm, glows) : lm;
  const colours = reflectedRgbTable(textures, lm);
  const levels = RELIEF_LEVELS.length;
  const vShift = Math.log2(size / WALL_V);

  for (let col = 0; col < w; col++) {
    const cameraX = (2 * col) / w - 1;
    const rayX = dirX + planeX * cameraX;
    const rayY = dirY + planeY * cameraX;
    castRay(map, p.x, p.y, rayX, rayY, hit);
    zbuffer[col] = hit.distance;

    const lineH = hit.tile === 0 ? 0 : proj / hit.distance;
    const start = Math.max(0, Math.floor(half - lineH / 2));
    const end = Math.max(start, Math.min(h, Math.floor(half + lineH / 2)));
    wallStart[col] = start;
    wallEnd[col] = end;
    if (end === start) {
      continue;
    }
    const tex = textures[hit.tile] as Uint32Array;
    const relief = RELIEF[hit.tile] as Uint8Array;
    let texX = Math.floor(hit.wallX * size);
    if ((hit.side === 0 && rayX > 0) || (hit.side === 1 && rayY < 0)) {
      texX = size - texX - 1;
    }
    const face = hit.side === 0 ? (rayX > 0 ? 0 : 1) : rayY > 0 ? 2 : 3;
    const base = faceOffset[(hit.mapY * map.width + hit.mapX) * 4 + face] as number;
    const lightCol = base + Math.floor(hit.wallX * WALL_U) * WALL_V;
    // A wall you're close to reflects the lamp it shows best: a soft spot face-on, a streak towards the lamp seen
    // along it. It fades as you step away from the wall itself (not its endless plane), and with distance along it.
    const normal = FACES.at(face);
    const hitX = p.x + hit.distance * rayX;
    const hitY = p.y + hit.distance * rayY;
    const away =
      normal && base >= 0 ? distanceToWall(lm, base, normal.dx, normal.dy, hitX, hitY, p.x, p.y) / REFLECTION_NEAR : 1;
    const far = hit.distance / REFLECTION_RANGE;
    const fade = away < 1 && far < 1 ? (1 - away * away) * (1 - far * far) * 255 : 0;
    const { shininess, f0 } = REFLECTION_MATERIAL[hit.tile] as (typeof REFLECTION_MATERIAL)[number];
    const slot = (lightCol / WALL_V) * REFLECTION_LAMPS;
    const lampIndex =
      reflections === 'none' || base < 0 || !normal || fade === 0
        ? -1
        : brightestReflection(lm, slot, shininess, f0, normal.dx, normal.dy, hitX, hitY, p.x, p.y, peak);
    const scale = fade * REFLECTION_STRENGTH;
    // Under half a step of brightness at its peak, the column shows nothing: skip it.
    const lamp = lampIndex < 0 || (peak[0] as number) * scale < 0.5 ? null : lm.lights.at(lampIndex);
    if (lamp && normal) {
      for (let i = 0; i < REFLECTION_SAMPLES; i++) {
        const z = i / (REFLECTION_SAMPLES - 1);
        reflected[i] = reflection(lamp, shininess, f0, normal.dx, normal.dy, 0, hitX, hitY, z, p.x, p.y) * scale;
      }
    }
    // Avatars' glow on this column: the ones close enough and in front of it.
    columnGlowCount = 0;
    if (normal && base >= 0) {
      for (const g of glows) {
        const dx = g.x - hitX;
        const dy = g.y - hitY;
        if (dx * normal.dx + dy * normal.dy > 0 && dx * dx + dy * dy < GLOW_RADIUS * GLOW_RADIUS) {
          columnGlows[columnGlowCount++] = g;
        }
      }
    }
    if (columnGlowCount > 0 && normal) {
      for (let j = 0; j < GLOW_HEIGHTS; j++) {
        const z = j / (GLOW_HEIGHTS - 1);
        let gr = 0;
        let gg = 0;
        let gb = 0;
        for (let k = 0; k < columnGlowCount; k++) {
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
    }
    const gloss = GLOSS[hit.tile] as Uint8Array;
    const colour = (hit.tile * lm.lights.length + lampIndex) * 3;
    const addR = colours[colour] as number;
    const addG = colours[colour + 1] as number;
    const addB = colours[colour + 2] as number;
    const step = size / lineH;
    let texPos = (start - half + lineH / 2) * step;
    // A near wall spreads each texel over several rows: shade it once and repeat it.
    let shadedY = -1;
    let shaded = 0;
    for (let y = start; y < end; y++) {
      const texY = Math.min(size - 1, texPos | 0);
      texPos += step;
      if (texY === shadedY) {
        pixels[y * w + col] = shaded;
        continue;
      }
      shadedY = texY;
      const t = texY * size + texX;
      // A face with no floor in front can't be seen; −1 only guards rounding at the map edge.
      if (base < 0) {
        shaded = tex[t] as number;
        pixels[y * w + col] = shaded;
        continue;
      }
      const c = tex[t] as number;
      // The baked light for this sample at this texel's relief level.
      const l = wall[(lightCol + (texY >> vShift)) * levels + (relief[t] as number)] as number;
      let r = ((c & 0xff) * (l & 0xff)) >> 7;
      let g = (((c >>> 8) & 0xff) * ((l >>> 8) & 0xff)) >> 7;
      let b = (((c >>> 16) & 0xff) * ((l >>> 16) & 0xff)) >> 7;
      if (lamp && gloss[t] === 1) {
        // Blend the two samples either side of this texel row's height.
        const at = (1 - (texY + 0.5) / size) * (REFLECTION_SAMPLES - 1);
        const below = at | 0;
        const low = reflected[below] as number;
        const high = reflected[Math.min(below + 1, REFLECTION_SAMPLES - 1)] as number;
        const s = low + (high - low) * (at - below);
        r += (s * addR) | 0;
        g += (s * addG) | 0;
        b += (s * addB) | 0;
      }
      if (columnGlowCount > 0) {
        // Blend the two heights either side of this texel row.
        const at = (1 - (texY + 0.5) / size) * (GLOW_HEIGHTS - 1);
        const below = at | 0;
        const above = Math.min(below + 1, GLOW_HEIGHTS - 1);
        const t = at - below;
        const gr = (columnGlowLight[below * 3] as number) * (1 - t) + (columnGlowLight[above * 3] as number) * t;
        const gg =
          (columnGlowLight[below * 3 + 1] as number) * (1 - t) + (columnGlowLight[above * 3 + 1] as number) * t;
        const gb =
          (columnGlowLight[below * 3 + 2] as number) * (1 - t) + (columnGlowLight[above * 3 + 2] as number) * t;
        r += ((c & 0xff) * gr) | 0;
        g += (((c >>> 8) & 0xff) * gg) | 0;
        b += (((c >>> 16) & 0xff) * gb) | 0;
      }
      if (r > 255) {
        r = 255;
      }
      if (g > 255) {
        g = 255;
      }
      if (b > 255) {
        b = 255;
      }
      shaded = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      pixels[y * w + col] = shaded;
    }
  }

  // Floor and ceiling: along a row the cast point moves linearly, so step it instead of re-projecting.
  const px = p.x * sub;
  const py = p.y * sub;
  const maxX = stride - 1;
  const maxY = rows - 1;
  const floorTop = Math.ceil(half);
  let shows = false;
  for (let y = 0; y < h; y++) {
    const d = rowDist[y] as number;
    const above = y < half;
    const table = above ? ceiling : floor;
    let fx = px + d * (dirX - planeX);
    let fy = py + d * (dirY - planeY);
    const sx = (d * 2 * planeX) / w;
    const sy = (d * 2 * planeY) / w;
    const row = y * w;
    // The floor reflects the lamps, and the ceiling their light off the floor: worked out every FLOOR_STEP pixels on
    // every other row, blended between. It changes slowly down the screen, so the next row reuses it.
    if (reflections === 'both' && (above ? y : y - floorTop) % 2 === 0) {
      shows = d / sub < REFLECTION_RANGE && shineFloorRow(lm, p, fx / sub, fy / sub, sx / sub, sy / sub, above);
    }
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
      const c = table[iy * stride + ix] as number;
      let out = c;
      if (shows) {
        const share = above ? CEILING_SHINE : 1;
        out = shineFloorPixel(lm, c, col, (iy * stride + ix) * REFLECTION_LAMPS, colours, textures.length, share);
      }
      pixels[row + col] = out;
    }
  }
}
