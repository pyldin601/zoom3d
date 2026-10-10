import { describe, expect, test } from 'vitest';
import { createFramebuffer } from './framebuffer';
import {
  OWN_BOB,
  OWN_CROP,
  OWN_HELD_SPRITES,
  OWN_LEFT,
  OWN_SIP_VISIBLE,
  OWN_SWAY,
  OWN_TEXEL,
  renderOwnHeld,
} from './own-held';
import { hexToRgb } from './sprites';

const W = 640;
const H = 360;

/** Screen pixel of texel (u, v) of the player's own beer. */
function at(u: number, v: number, bob = 0, sway = 0, sip = 0) {
  const { w: tw, h: th } = OWN_HELD_SPRITES.beer;
  const t = OWN_TEXEL * H;
  const lerp = (a: number, b: number) => a + (b - a) * sip;
  const left = lerp(OWN_LEFT * W, (W - tw * t) / 2) + sway * OWN_SWAY * W;
  const top = H - lerp(1 - OWN_CROP, OWN_SIP_VISIBLE) * th * t + bob * OWN_BOB * H;
  return Math.floor(top + (v + 0.5) * t) * W + Math.floor(left + (u + 0.5) * t);
}
const tex = (u: number, v: number) => OWN_HELD_SPRITES.beer.texels[v * OWN_HELD_SPRITES.beer.w + u];

describe('renderOwnHeld', () => {
  test('is the in-game beer mirrored: the hand on the left, toward the screen edge', () => {
    expect(tex(2, 4)).toBe(hexToRgb('#f2c29b'));
    expect(tex(7, 3)).toBe(hexToRgb('#e8a317'));
  });

  test('draws the drink peeking in at the bottom-left', () => {
    const fb = createFramebuffer();
    renderOwnHeld(fb, 'beer', 0, 0, 0);
    // Foam, beer and fist.
    for (const [u, v] of [
      [7, 1],
      [7, 3],
      [2, 4],
    ] as const) {
      expect(fb.pixels[at(u, v)]).toBe(tex(u, v));
    }
  });

  test('nothing in hand draws nothing', () => {
    const fb = createFramebuffer();
    renderOwnHeld(fb, null, 1, 1, 1);
    expect(fb.pixels.every((c) => c === 0)).toBe(true);
  });

  test('walking moves it down with the bob and sideways with the sway', () => {
    const still = createFramebuffer();
    renderOwnHeld(still, 'beer', 0, 0, 0);
    const moved = createFramebuffer();
    renderOwnHeld(moved, 'beer', 1, -1, 0);
    for (const [u, v] of [
      [7, 1],
      [5, 3],
      [2, 4],
    ] as const) {
      expect(moved.pixels[at(u, v, 1, -1)]).toBe(tex(u, v));
    }
    expect(moved.pixels).not.toEqual(still.pixels);
  });

  test('at full sip the drink is centred and lower', () => {
    const fb = createFramebuffer();
    renderOwnHeld(fb, 'beer', 0, 0, 1);
    // Only the top 30% shows: rows 0–2 of the sprite.
    for (const [u, v] of [
      [7, 1],
      [5, 2],
    ] as const) {
      expect(fb.pixels[at(u, v, 0, 0, 1)]).toBe(tex(u, v));
    }
    expect(fb.pixels[at(7, 1)]).not.toBe(tex(7, 1));
  });

  test.each([
    [0, 0],
    [1, 1],
    [1, -1],
  ])('stays in the bottom-left corner (bob %d, sway %d)', (bob, sway) => {
    for (const item of ['beer', 'coffee', 'wine'] as const) {
      const fb = createFramebuffer();
      renderOwnHeld(fb, item, bob, sway, 0);
      fb.pixels.forEach((c, i) => {
        if (c !== 0) {
          expect(i % W).toBeLessThan(W / 2);
          expect(Math.floor(i / W)).toBeGreaterThan(H * 0.6);
        }
      });
    }
  });
});
