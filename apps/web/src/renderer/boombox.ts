// The boombox a carrier holds by the handle, on the viewer's left of the disc: the avatar's right
// hand, opposite the drink (boombox spec §2.1). It shares the held items' texel size and palette.
import { HELD_LEFT, HELD_PALETTE, HELD_TEXEL, type HeldSprite, toHeldSprite } from './held-items';

// biome-ignore format: one row per line keeps the pixel art readable
export const BOOMBOX_MAP: readonly string[] = [
  '.....oooooo.....',
  '....osssssso....',
  '....hllllllh....',
  '....h.oooo.h....',
  'kkkkkkkkkkkkkkkk',
  'kmmmmmmmmmmmmmmk',
  'kmnnnmeeeemnnnmk',
  'knninneyyenninnk',
  'knidineyyenidink',
  'knninneeeenninnk',
  'kmnnnmmxxmmnnnmk',
  'kkkkkkkkkkkkkkkk',
];

export const BOOMBOX_SPRITE: HeldSprite = toHeldSprite(BOOMBOX_MAP, {
  ...HELD_PALETTE,
  k: '#1e1e1e',
  m: '#a7afb8',
  n: '#3a3a3a',
  i: '#6e6e6e',
  d: '#111111',
  e: '#555555',
  y: '#e8a317',
  x: '#dd3333',
  h: '#4a4a4a',
});

/** Left edge in disc radii from the disc centre: the right edge mirrors the drink's left edge. */
export const BOOMBOX_LEFT = -(HELD_LEFT + BOOMBOX_SPRITE.w * HELD_TEXEL);
/** Top in disc radii above the horizon (negative: below), so it hangs to just past the disc. */
export const BOOMBOX_TOP = -0.15;
