// The player's own boombox in first person, peeking in at the bottom-right: the right hand, opposite
// the drink at the bottom-left (boombox spec §2.2). The sprite is symmetric, so it isn't mirrored.
import { BOOMBOX_SPRITE } from './boombox';
import type { Framebuffer } from './framebuffer';
import { drawOverlay, OWN_BOB, OWN_SWAY, OWN_TEXEL } from './own-held';

/** Right edge as a fraction of the width: clear of the camera self-view (~0.908 onward). */
export const OWN_BOOMBOX_RIGHT = 0.88;
/** Fraction of the sprite's height hidden below the bottom edge: the fist, handle and body top show. */
export const OWN_BOOMBOX_CROP = 0.5;

/** Draws over the scene; `bob` 0..1 drops it, `sway` −1..1 shifts it the other way from the drink. */
export function renderOwnBoombox(fb: Framebuffer, on: boolean, bob: number, sway: number): void {
  if (!on) {
    return;
  }
  const { width: w, height: h } = fb;
  const { w: tw, h: th } = BOOMBOX_SPRITE;
  const t = OWN_TEXEL * h;
  const left = OWN_BOOMBOX_RIGHT * w - tw * t - sway * OWN_SWAY * w;
  const top = h - (1 - OWN_BOOMBOX_CROP) * th * t + bob * OWN_BOB * h;
  drawOverlay(fb, BOOMBOX_SPRITE, left, top, t);
}
