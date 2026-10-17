// The player's own drink in first person, peeking in at the bottom-left. Others see it in the
// avatar's left hand, so here it is the in-game sprite mirrored: the hand and handle toward the
// screen edge, the drink toward the centre (held items spec §2.1).
import type { HeldItem } from '@zoom3d/shared';
import type { Bob } from './bob';
import type { Framebuffer } from './framebuffer';
import { blitHeldSprite, HELD_MAPS, type HeldSprite, OVER_EVERYTHING, toHeldSprite } from './held-items';
import { type HeldPose, poseBlend } from './sip';

/** Texel size, as a fraction of the screen's shorter side (the height on desktop). */
export const OWN_TEXEL = 0.046;
/** Left edge, as a fraction of the screen width. */
export const OWN_LEFT = 0.083;
/** Fraction of the sprite's height hidden below the bottom edge. */
export const OWN_CROP = 0.45;
/** Walking: drop at the top of a step (fraction of the height), sway either way (fraction of the width). */
export const OWN_BOB = 0.03;
export const OWN_SWAY = 0.01;
/** At the top of a sip the drink sits at the bottom-centre, under the player's mouth, this much of it visible. */
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

/** The walking step as the held items feel it: `itemLift` 0..1 drops it, `sway` −1..1 shifts it sideways. */
export type HeldStep = Pick<Bob, 'itemLift' | 'sway'>;

/** One texel of a first-person overlay, in framebuffer pixels: from the shorter side, so a tall phone frame keeps it small. */
export function ownTexel(fb: Framebuffer): number {
  return OWN_TEXEL * Math.min(fb.width, fb.height);
}

/**
 * Draws over the scene, moved by the step; a sip brings it to the bottom-centre (held items spec §2.3) and a cheers
 * raises it into view (§2.4).
 */
export function renderOwnHeld(fb: Framebuffer, item: HeldItem | null, step: HeldStep, pose: HeldPose): void {
  if (!item) {
    return;
  }
  const { width: w, height: h } = fb;
  const sprite = OWN_HELD_SPRITES[item];
  const { w: tw, h: th } = sprite;
  const t = ownTexel(fb);
  const centredLeft = (w - tw * t) / 2;
  const sideways = (step.sway * OWN_SWAY + pose.wobble * OWN_CHEERS_WOBBLE) * w;
  const left = poseBlend(pose, OWN_LEFT * w, centredLeft, OWN_CHEERS_LEFT * w) + sideways;
  const topAboveBottomEdge = poseBlend(
    pose,
    (1 - OWN_CROP) * th * t,
    OWN_SIP_VISIBLE * th * t,
    th * t + OWN_CHEERS_RAISE * h
  );
  const top = h - topAboveBottomEdge + step.itemLift * OWN_BOB * h;
  blitHeldSprite(fb, sprite, left, top, t, OVER_EVERYTHING);
}
