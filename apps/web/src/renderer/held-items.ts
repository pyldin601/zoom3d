// Pixel-art drinks held in a floating hand beside an avatar disc (held items spec §2). Column 0 is
// the side next to the disc: the drink is there and the hand grips it from the outside, mugs by the
// handle, the wine glass by the stem, the lighter by its case with the flame on top (lighter spec §3.1).
import type { Drink, HeldItem } from '@zoom3d/shared';
import { MOUTH_Y_IN_CROP } from '../media/framing';
import { WHOLE_FRAME } from './camera';
import { type Framebuffer, rgb } from './framebuffer';

/**
 * Item geometry in disc radii: texel size, left edge right of the disc centre, top above the horizon
 * (negative: below). The hand covers the disc's lower right, in front of the body.
 */
export const HELD_TEXEL = 0.08;
export const HELD_LEFT = 0.15;
export const HELD_TOP = -0.3;
/** Raised in a cheers (held items spec §2.4): left edge and top in disc radii, and the wobble's reach either way. */
export const CHEERS_LEFT = 0.35;
export const CHEERS_TOP = 1.15;
export const CHEERS_WOBBLE = 0.06;
/** The framed 256² face texture spans the disc's inner circle, 0.85 r in radius (sprites.ts `FACE_RADIUS`). */
const FACE_SPAN = 1.7;
/**
 * The mouth of a framed face, in disc radii below the disc centre (held items spec §2.3): face framing puts
 * it at `MOUTH_Y_IN_CROP` of the framed video's height, horizontally centred.
 */
export const FACE_MOUTH_Y = (MOUTH_Y_IN_CROP - 0.5) * FACE_SPAN;
/** The texel (u, v) of each drink that meets the lips at the top of a sip: its rim, or the foam. */
export const HELD_LIPS: Readonly<Record<Drink, readonly [number, number]>> = {
  beer: [3.5, 2.5],
  coffee: [3.5, 2],
  wine: [4, 0.5],
};
/** At the top of a sip: the sprite's left edge and top (as HELD_LEFT/HELD_TOP) that put its lip point on the mouth. */
export const sipLeft = (item: Drink) => -(HELD_LIPS[item][0] * HELD_TEXEL);
export const sipTop = (item: Drink) => HELD_LIPS[item][1] * HELD_TEXEL - FACE_MOUTH_Y;

export interface HeldSprite {
  w: number;
  h: number;
  /** Packed like rgb(); 0 is transparent. */
  texels: Uint32Array;
}

/** The depth to blit at for a first-person overlay: nearer than any wall, so it covers the whole scene. */
export const OVER_EVERYTHING = Number.NEGATIVE_INFINITY;

export const HELD_PALETTE: Readonly<Record<string, string>> = {
  s: '#f2c29b',
  l: '#c98d6a',
  o: '#8a5236',
  g: '#cfe3ea',
  f: '#f4f1e6',
  F: '#d6cfba',
  b: '#e8a317',
  B: '#b8740f',
  t: '#b9c0c8',
  c: '#5a3620',
  w: '#f3f3f3',
  W: '#bdbdbd',
  R: '#8e1b2b',
  r: '#c23a4c',
  k: '#c8ccd2',
  K: '#8d939b',
  y: '#ffe27a',
  Y: '#ff9a2e',
};

// biome-ignore format: one row per line keeps the pixel art readable
export const HELD_MAPS: Readonly<Record<HeldItem, readonly string[]>> = {
  beer: [
    '.fffff....',
    'fffffff...',
    'fFffFfg...',
    'gbbbbooo..',
    'gBbbbosso.',
    'gBbbbolso.',
    'gBbbbosso.',
    'gBbbbooo..',
    'gbbbbbg...',
    'ggggggg...',
  ],
  coffee: [
    '..t..t....',
    '.t..t.....',
    'wccccw....',
    'wwwwwooo..',
    'wwwwwosso.',
    'wwwwwolso.',
    'wwwwwosso.',
    'wwwwwooo..',
    '.WWWWW....',
  ],
  wine: [
    'g.....g',
    'g.....g',
    'gRRRRRg',
    'gRrRRRg',
    '.gRooo.',
    '..gsso.',
    '.ossss.',
    '.ollll.',
    '.ooooo.',
    '.ggggg.',
  ],
  lighter: [
    '.Y.....',
    'YyY....',
    '.y.....',
    'kkkooo.',
    'kKkosso',
    'kKkolso',
    'kKkosso',
    'kKkooo.',
    'kKk....',
    'kkk....',
  ],
};

/** Packs a pixel map (one string per row, `.` transparent) into a texture. */
export function toHeldSprite(rows: readonly string[], palette = HELD_PALETTE): HeldSprite {
  const w = rows[0]?.length ?? 0;
  const h = rows.length;
  const texels = new Uint32Array(w * h);
  rows.forEach((row, v) => {
    [...row].forEach((ch, u) => {
      const hex = palette[ch];
      if (hex) {
        const n = Number.parseInt(hex.slice(1), 16);
        texels[v * w + u] = rgb((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
      }
    });
  });
  return { w, h, texels };
}

export const HELD_SPRITES: Record<HeldItem, HeldSprite> = {
  beer: toHeldSprite(HELD_MAPS.beer),
  coffee: toHeldSprite(HELD_MAPS.coffee),
  wine: toHeldSprite(HELD_MAPS.wine),
  lighter: toHeldSprite(HELD_MAPS.lighter),
};

/**
 * Draws `sprite` with texels `texelPx` wide from (left, top), clipped to the frame and the pass, in the columns whose
 * wall is farther than `depth`.
 */
export function blitHeldSprite(
  fb: Framebuffer,
  sprite: HeldSprite,
  left: number,
  top: number,
  texelPx: number,
  depth: number,
  pass = WHOLE_FRAME
): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const { w: tw, h: th, texels } = sprite;
  const near = pass.nearDepth;
  const firstCol = Math.max(pass.fromCol, Math.floor(left));
  const lastCol = Math.min(w - 1, pass.toCol - 1, Math.ceil(left + tw * texelPx) - 1);
  const firstRow = Math.max(0, Math.floor(top));
  const lastRow = Math.min(h - 1, Math.ceil(top + th * texelPx) - 1);
  for (let col = firstCol; col <= lastCol; col++) {
    if (depth >= (zbuffer[col] as number) || (near !== null && depth <= (near[col] as number))) {
      continue;
    }
    const u = Math.floor((col + 0.5 - left) / texelPx);
    if (u < 0 || u >= tw) {
      continue;
    }
    for (let row = firstRow; row <= lastRow; row++) {
      const v = Math.floor((row + 0.5 - top) / texelPx);
      if (v < 0 || v >= th) {
        continue;
      }
      const c = texels[v * tw + u] as number;
      if (c !== 0) {
        pixels[row * w + col] = c;
      }
    }
  }
}
