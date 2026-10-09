// Pixel-art drinks held in a floating hand beside an avatar disc (held items spec §2). Column 0 is
// the side next to the disc: mugs are gripped by the handle, the wine glass by the stem.
import type { HeldItem } from '@zoom3d/shared';
import { rgb } from './framebuffer';

/**
 * Item geometry in disc radii: texel size, left edge right of the disc centre, top above the horizon
 * (negative: below). The hand covers the disc's lower right, in front of the body.
 */
export const HELD_TEXEL = 0.08;
export const HELD_LEFT = 0.15;
export const HELD_TOP = -0.3;

export interface HeldSprite {
  w: number;
  h: number;
  /** Packed like rgb(); 0 is transparent. */
  texels: Uint32Array;
}

const PALETTE: Record<string, string> = {
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
    '.......fffff.',
    '......fffffff',
    '...oooofFffFf',
    '...osssobbbbg',
    '.ossssgbbbbbg',
    'oollllgbbbbBg',
    'oossssgbbbbBg',
    '.ooooogbbbbBg',
    '......gbbbbbg',
    '......ggggggg',
  ],
  coffee: [
    '.......t..t..',
    '...oooo.t..t.',
    '...osssoccccw',
    '.osssswwwwwww',
    'oollllwwwwwww',
    'oosssswwwwwww',
    '.ooooowwwwwww',
    '......Wwwwwww',
    '.......WWWWW.',
  ],
  wine: [
    'g.....g',
    'g.....g',
    'gRRRRRg',
    'gRRRrRg',
    '.oooRg.',
    '.ossg..',
    '.sssso.',
    '.llllo.',
    '.ooooo.',
    '.ggggg.',
  ],
};

/** Packs a pixel map (one string per row, `.` transparent) into a texture. */
export function toHeldSprite(rows: readonly string[]): HeldSprite {
  const w = rows[0]?.length ?? 0;
  const h = rows.length;
  const texels = new Uint32Array(w * h);
  rows.forEach((row, v) => {
    [...row].forEach((ch, u) => {
      const hex = PALETTE[ch];
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
