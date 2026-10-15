// Column-by-column textured wall renderer with flat ceiling and floor.
import { castRay, createRayHit, type GameMap, type PlayerState } from '@zoom3d/shared';
import { reflectedColour } from './colour';
import { type Framebuffer, rgb } from './framebuffer';
import {
  brightestReflection,
  FACES,
  FLOOR_LAMP_SUB,
  FLOOR_SUB,
  type Lighting,
  REFLECTION_LAMPS,
  REFLECTION_NEAR,
  REFLECTION_RANGE,
  REFLECTION_SAMPLES,
  REFLECTION_STRENGTH,
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
  lighting: Lighting | null = null
): void {
  if (lighting) {
    renderLitWalls(fb, map, p, textures, lighting);
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
 * Works out the floor's reflection along one screen row, every FLOOR_STEP pixels, into floorShine and floorShineLamp:
 * the row's floor point at pixel col is (x0 + dx·col, y0 + dy·col) in tiles. Returns whether any of it shows.
 */
function shineFloorRow(lm: Lighting, p: PlayerState, x0: number, y0: number, dx: number, dy: number): boolean {
  const across = lm.map.width * FLOOR_LAMP_SUB;
  const down = lm.map.height * FLOOR_LAMP_SUB;
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
    const cx = Math.floor(x * FLOOR_LAMP_SUB);
    const cy = Math.floor(y * FLOOR_LAMP_SUB);
    if (far2 >= 1 || cx < 0 || cy < 0 || cx >= across || cy >= down) {
      continue;
    }
    const slot = (cy * across + cx) * REFLECTION_LAMPS;
    for (let k = 0; k < REFLECTION_LAMPS; k++) {
      const index = lm.floorLamp[slot + k] as number;
      const lamp = lm.lights.at(index);
      if (index < 0 || !lamp) {
        break;
      }
      const shine = reflection(lamp, shininess, f0, 0, 0, 1, x, y, 0, p.x, p.y) * (1 - far2) * scale;
      if (shine > (floorShine[i] as number)) {
        floorShine[i] = shine;
        floorShineLamp[i] = index;
      }
    }
    shows ||= (floorShine[i] as number) >= 0.5;
  }
  return shows;
}

function renderLitWalls(fb: Framebuffer, map: GameMap, p: PlayerState, textures: Uint32Array[], lm: Lighting): void {
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
  const { faceOffset, wall, floor, ceiling, stride, rows } = lm;
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
    // along it. It fades as you step away from the wall's face, and with distance along it.
    const normal = FACES.at(face);
    const hitX = p.x + hit.distance * rayX;
    const hitY = p.y + hit.distance * rayY;
    const away = normal ? ((p.x - hitX) * normal.dx + (p.y - hitY) * normal.dy) / REFLECTION_NEAR : 1;
    const far = hit.distance / REFLECTION_RANGE;
    const fade = away < 1 && far < 1 ? (1 - away * away) * (1 - far * far) * 255 : 0;
    const { shininess, f0 } = REFLECTION_MATERIAL[hit.tile] as (typeof REFLECTION_MATERIAL)[number];
    const slot = (lightCol / WALL_V) * REFLECTION_LAMPS;
    const lampIndex =
      base < 0 || !normal || fade === 0
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
  let floorShows = false;
  for (let y = 0; y < h; y++) {
    const d = rowDist[y] as number;
    const above = y < half;
    const table = above ? ceiling : floor;
    let fx = px + d * (dirX - planeX);
    let fy = py + d * (dirY - planeY);
    const sx = (d * 2 * planeX) / w;
    const sy = (d * 2 * planeY) / w;
    const row = y * w;
    // The floor reflects the lamps: worked out every FLOOR_STEP pixels on every other row, blended between. It changes
    // slowly down the screen, so the row below reuses it.
    if (!above && (y - floorTop) % 2 === 0) {
      floorShows = d / sub < REFLECTION_RANGE && shineFloorRow(lm, p, fx / sub, fy / sub, sx / sub, sy / sub);
    }
    const shines = !above && floorShows;
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
      if (!shines) {
        pixels[row + col] = c;
        continue;
      }
      const i = (col / FLOOR_STEP) | 0;
      const left = floorShine[i] as number;
      const right = floorShine[i + 1] as number;
      const s = left + (right - left) * ((col - i * FLOOR_STEP) / FLOOR_STEP);
      if (s < 0.5) {
        pixels[row + col] = c;
        continue;
      }
      const colour = (textures.length * lm.lights.length + (floorShineLamp[left >= right ? i : i + 1] as number)) * 3;
      let r = (c & 0xff) + ((s * (colours[colour] as number)) | 0);
      let g = ((c >>> 8) & 0xff) + ((s * (colours[colour + 1] as number)) | 0);
      let b = ((c >>> 16) & 0xff) + ((s * (colours[colour + 2] as number)) | 0);
      if (r > 255) {
        r = 255;
      }
      if (g > 255) {
        g = 255;
      }
      if (b > 255) {
        b = 255;
      }
      pixels[row + col] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
}
