// The player's own drink in first person, peeking in at the bottom-left. Others see it in the
// avatar's left hand, so here it is the in-game sprite mirrored: the hand and handle toward the
// screen edge, the drink toward the centre (held items spec §2.1).
import type { HeldItem } from '@zoom3d/shared';
import type { Framebuffer } from './framebuffer';
import { HELD_MAPS, type HeldSprite, toHeldSprite } from './held-items';
import type { HeldPose } from './sip';

/** Texel size, as a fraction of the screen's shorter side (the height on desktop). */
export const OWN_TEXEL = 0.046;
/** Left edge, as a fraction of the screen width. */
export const OWN_LEFT = 0.083;
/** Fraction of the sprite's height hidden below the bottom edge. */
export const OWN_CROP = 0.45;
/** Walking: drop at the top of a step (fraction of the height), sway either way (fraction of the width). */
export const OWN_BOB = 0.03;
export const OWN_SWAY = 0.01;
/** At the top of a sip the drink sits at the bottom-centre, under your mouth, this much of it visible. */
export const OWN_SIP_VISIBLE = 0.3;
/**
 * Raised in a cheers (held items spec §2.4): left edge at this fraction of the width, fully in view with its bottom
 * this fraction of the height above the bottom edge, wobbling by this fraction of the width.
 */
export const OWN_CHEERS_LEFT = 0.2;
export const OWN_CHEERS_RAISE = 0.08;
export const OWN_CHEERS_WOBBLE = 0.015;

const mirror = (rows: readonly string[]) => rows.map((row) => [...row].reverse().join(''));

export const OWN_HELD_SPRITES: Record<HeldItem, HeldSprite> = {
  beer: toHeldSprite(mirror(HELD_MAPS.beer)),
  coffee: toHeldSprite(mirror(HELD_MAPS.coffee)),
  wine: toHeldSprite(mirror(HELD_MAPS.wine)),
};

/** One texel of a first-person overlay, in framebuffer pixels: from the shorter side, so a tall phone frame keeps it small. */
export function ownTexel(fb: Framebuffer): number {
  return OWN_TEXEL * Math.min(fb.width, fb.height);
}

/**
 * Draws over the scene; `bob` 0..1 drops it, `sway` −1..1 shifts it sideways, a sip brings it to the bottom-centre
 * (held items spec §2.3) and a cheers raises it into view (§2.4).
 */
export function renderOwnHeld(fb: Framebuffer, item: HeldItem | null, bob: number, sway: number, pose: HeldPose): void {
  if (!item) {
    return;
  }
  const { width: w, height: h } = fb;
  const sprite = OWN_HELD_SPRITES[item];
  const { w: tw, h: th } = sprite;
  const t = ownTexel(fb);
  const rest = OWN_LEFT * w;
  const { sip, cheers, wobble } = pose;
  const left =
    rest +
    ((w - tw * t) / 2 - rest) * sip +
    (OWN_CHEERS_LEFT * w - rest) * cheers +
    (sway * OWN_SWAY + wobble * OWN_CHEERS_WOBBLE) * w;
  // How far the sprite's top sits above the bottom edge, at rest, at the top of a sip and raised in a cheers.
  const restUp = (1 - OWN_CROP) * th * t;
  const up = restUp + (OWN_SIP_VISIBLE * th * t - restUp) * sip + (th * t + OWN_CHEERS_RAISE * h - restUp) * cheers;
  const top = h - up + bob * OWN_BOB * h;
  drawOverlay(fb, sprite, left, top, t);
}

/** Draws a sprite with texel size t over the scene at (left, top), clipped to the screen. */
export function drawOverlay(fb: Framebuffer, sprite: HeldSprite, left: number, top: number, t: number): void {
  const { width: w, height: h, pixels } = fb;
  const { w: tw, h: th, texels } = sprite;
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
