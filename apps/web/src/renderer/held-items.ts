// Pixel-art drinks held in a floating hand beside an avatar disc (held items spec §2). Column 0 is
// the side next to the disc: the drink is there and the hand grips it from the outside, mugs by the
// handle, the wine glass by the stem.
import type { HeldItem } from '@zoom3d/shared';
import { MOUTH_Y_IN_CROP } from '../media/framing';
import { rgb } from './framebuffer';

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
/** The framed 256² face texture spans the disc's inner circle, 0.85 r in radius (sprites.ts `RING`). */
const FACE_SPAN = 1.7;
/**
 * The mouth of a framed face, in disc radii below the disc centre (held items spec §2.3): face framing puts
 * it at `MOUTH_Y_IN_CROP` of the framed video's height, horizontally centred.
 */
export const FACE_MOUTH_Y = (MOUTH_Y_IN_CROP - 0.5) * FACE_SPAN;
/** The texel (u, v) of each drink that meets the lips at the top of a sip: its rim, or the foam. */
export const HELD_LIPS: Readonly<Record<HeldItem, readonly [number, number]>> = {
  beer: [3.5, 2.5],
  coffee: [3.5, 2],
  wine: [4, 0.5],
};
/** At the top of a sip: the sprite's left edge and top (as HELD_LEFT/HELD_TOP) that put its lip point on the mouth. */
export const sipLeft = (item: HeldItem) => -(HELD_LIPS[item][0] * HELD_TEXEL);
export const sipTop = (item: HeldItem) => HELD_LIPS[item][1] * HELD_TEXEL - FACE_MOUTH_Y;

export interface HeldSprite {
  w: number;
  h: number;
  /** Packed like rgb(); 0 is transparent. */
  texels: Uint32Array;
}

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
};
