// The player's own drink in first person, peeking in at the bottom-left. Others see it in the
// avatar's left hand, so here it is the in-game sprite mirrored: the hand and handle toward the
// screen centre, the drink on the outside (held items spec §2.1).
import type { HeldItem } from '@zoom3d/shared';
import type { Framebuffer } from './framebuffer';
import { HELD_MAPS, type HeldSprite, toHeldSprite } from './held-items';

/** Texel size, as a fraction of the screen height. */
export const OWN_TEXEL = 0.046;
/** Left edge, as a fraction of the screen width. */
export const OWN_LEFT = 0.083;
/** Fraction of the sprite's height hidden below the bottom edge. */
export const OWN_CROP = 0.45;
/** Walking: drop at the top of a step (fraction of the height), sway either way (fraction of the width). */
export const OWN_BOB = 0.03;
export const OWN_SWAY = 0.01;

const mirror = (rows: readonly string[]) => rows.map((row) => [...row].reverse().join(''));

export const OWN_HELD_SPRITES: Record<HeldItem, HeldSprite> = {
  beer: toHeldSprite(mirror(HELD_MAPS.beer)),
  coffee: toHeldSprite(mirror(HELD_MAPS.coffee)),
  wine: toHeldSprite(mirror(HELD_MAPS.wine)),
};

/** Draws over the scene; `bob` 0..1 drops it, `sway` −1..1 shifts it sideways. */
export function renderOwnHeld(fb: Framebuffer, item: HeldItem | null, bob: number, sway: number): void {
  if (!item) {
    return;
  }
  const { width: w, height: h, pixels } = fb;
  const { w: tw, h: th, texels } = OWN_HELD_SPRITES[item];
  const t = OWN_TEXEL * h;
  const left = (OWN_LEFT + sway * OWN_SWAY) * w;
  const top = h - (1 - OWN_CROP) * th * t + bob * OWN_BOB * h;
  const x0 = Math.max(0, Math.floor(left));
  const x1 = Math.min(w - 1, Math.ceil(left + tw * t) - 1);
  const y0 = Math.max(0, Math.floor(top));
  for (let row = y0; row < h; row++) {
    const v = Math.floor((row + 0.5 - top) / t);
    if (v < 0 || v >= th) {
      continue;
    }
    for (let col = x0; col <= x1; col++) {
      const u = Math.floor((col + 0.5 - left) / t);
      if (u < 0 || u >= tw) {
        continue;
      }
      const c = texels[v * tw + u] as number;
      if (c !== 0) {
        pixels[row * w + col] = c;
      }
    }
  }
}
