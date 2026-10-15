// Procedural 64x64 wall textures, deterministic per seed. Index = tile id (0 unused).
import { rgb } from './framebuffer';

export const TEX = 64;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Paint = (x: number, y: number, noise: number) => [number, number, number];

function texture(rand: () => number, paint: Paint): Uint32Array {
  const tex = new Uint32Array(TEX * TEX);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const [r, g, b] = paint(x, y, rand() * 2 - 1);
      tex[y * TEX + x] = rgb(r, g, b);
    }
  }
  return tex;
}

// Staggered blocks: 16 px rows, 32 px blocks, 2 px mortar.
function isMortar(x: number, y: number): boolean {
  const row = Math.floor(y / 16);
  const offset = row % 2 === 0 ? 0 : 16;
  return y % 16 < 2 || (x + offset) % 32 < 2;
}

/** How much a brick edge brightens (top) or darkens (bottom) under full lamp light. */
const RELIEF_STRENGTH = 0.6;

/**
 * Relief levels, as multipliers of the lamp light added to a texel's light: flat, a brick's top row (catches the
 * light from the ceiling lamps), its bottom row, and the mortar right under it (in its shadow). RELIEF holds indices.
 */
export const RELIEF_LEVELS: readonly number[] = [0, RELIEF_STRENGTH, -RELIEF_STRENGTH, -RELIEF_STRENGTH / 2];
const FLAT = 0;
const RAISED = 1;
const SUNKEN = 2;
const SHADOWED = 3;

/** Brick relief, lit from above. Rows past the texture's edge count as no edge. */
function brickRelief(): Uint8Array {
  const relief = new Uint8Array(TEX * TEX);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const here = isMortar(x, y);
      const above = y > 0 && isMortar(x, y - 1);
      const below = y < TEX - 1 && isMortar(x, y + 1);
      let v = FLAT;
      if (!here && above) {
        v = RAISED;
      } else if (!here && below) {
        v = SUNKEN;
      } else if (here && y > 0 && !above) {
        v = SHADOWED;
      }
      relief[y * TEX + x] = v;
    }
  }
  return relief;
}

/** RELIEF_LEVELS index per texel and texture (index = tile id, like makeTextures): stone and blue are bricks, wood flat. */
export const RELIEF: readonly Uint8Array[] = [
  new Uint8Array(0),
  brickRelief(),
  new Uint8Array(TEX * TEX),
  brickRelief(),
];

/** Bricks shine, mortar doesn't. */
function brickGloss(): Uint8Array {
  const gloss = new Uint8Array(TEX * TEX);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      gloss[y * TEX + x] = isMortar(x, y) ? 0 : 1;
    }
  }
  return gloss;
}

export interface ReflectionMaterial {
  /** Blinn-Phong exponent: high is glossy (a small spot, a narrow streak), low is rough (faint and wide, a long streak). */
  shininess: number;
  /** How much of the reflection shows face-on; seen along the wall it rises towards full (see reflection()). */
  f0: number;
  /**
   * How much of the reflection is more of the surface's own colour, 0..1; the rest is the lamp's light, mixed in
   * OKLab so it never turns a wall a new hue (see reflectedColour). Brick at 0.85 shines a brighter blue: the lamp's
   * share alone washes a dark blue white.
   */
  tint: number;
}

const BRICK: ReflectionMaterial = { shininess: 8, f0: 0.05, tint: 0.85 };

/**
 * Per texture (index = tile id, like RELIEF). Varnished wood is glossy and reflects in the lamp's colour; brick is
 * rough, barely shines face-on and reflects in its own colour paled by the lamp's.
 */
export const REFLECTION_MATERIAL: readonly ReflectionMaterial[] = [
  { shininess: 1, f0: 0, tint: 0 },
  BRICK,
  { shininess: 16, f0: 0.4, tint: 0 },
  BRICK,
];

/** Per texel and texture (index = tile id, like RELIEF): 1 where a lamp can reflect, 0 where it can't. */
export const GLOSS: readonly Uint8Array[] = [
  new Uint8Array(0),
  brickGloss(),
  new Uint8Array(TEX * TEX).fill(1),
  brickGloss(),
];

export function makeTextures(seed = 1): Uint32Array[] {
  const rand = mulberry32(seed);
  const stone = texture(rand, (x, y, n) => {
    if (isMortar(x, y)) {
      return [70, 72, 70];
    }
    const v = 140 + n * 18;
    return [v, v + 2, v];
  });
  const wood = texture(rand, (x, y, n) => {
    const seam = x % 16 === 0;
    const grain = Math.sin((y + (x % 16) * 3) * 0.6) * 8;
    if (seam) {
      return [60, 38, 18];
    }
    return [122 + grain + n * 10, 80 + grain * 0.6 + n * 6, 40 + n * 4];
  });
  const blue = texture(rand, (x, y, n) => {
    if (isMortar(x, y)) {
      return [10, 10, 70];
    }
    return [12 + n * 6, 18 + n * 8, 150 + n * 25];
  });
  return [new Uint32Array(0), stone, wood, blue];
}
