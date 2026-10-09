import { describe, expect, test } from 'vitest';
import { BOOMBOX_SPRITE } from './boombox';
import { createFramebuffer } from './framebuffer';
import { OWN_BOOMBOX_CROP, OWN_BOOMBOX_RIGHT, renderOwnBoombox } from './own-boombox';
import { OWN_BOB, OWN_SWAY, OWN_TEXEL, renderOwnHeld } from './own-held';

const W = 640;
const H = 360;

/** Screen pixel of texel (u, v) of the player's own boombox. */
function at(u: number, v: number, bob = 0, sway = 0) {
  const { w: tw, h: th } = BOOMBOX_SPRITE;
  const t = OWN_TEXEL * H;
  const left = OWN_BOOMBOX_RIGHT * W - tw * t - sway * OWN_SWAY * W;
  const top = H - (1 - OWN_BOOMBOX_CROP) * th * t + bob * OWN_BOB * H;
  return Math.floor(top + (v + 0.5) * t) * W + Math.floor(left + (u + 0.5) * t);
}
const tex = (u: number, v: number) => BOOMBOX_SPRITE.texels[v * BOOMBOX_SPRITE.w + u];
const drawnColumns = (pixels: Uint32Array) => {
  const cols = new Set<number>();
  pixels.forEach((c, i) => {
    if (c !== 0) {
      cols.add(i % W);
    }
  });
  return cols;
};

describe('renderOwnBoombox', () => {
  test('constants from the spec', () => {
    expect(OWN_BOOMBOX_RIGHT).toBe(0.88);
    expect(OWN_BOOMBOX_CROP).toBe(0.5);
  });

  test('draws it peeking in at the bottom-right', () => {
    const fb = createFramebuffer();
    renderOwnBoombox(fb, true, 0, 0);
    for (const [u, v] of [
      [7, 1],
      [7, 4],
    ] as const) {
      expect(fb.pixels[at(u, v)]).toBe(tex(u, v));
    }
  });

  test('off draws nothing', () => {
    const fb = createFramebuffer();
    renderOwnBoombox(fb, false, 1, 1);
    expect(fb.pixels.every((c) => c === 0)).toBe(true);
  });

  test('it stays clear of the self-view', () => {
    for (const sway of [-1, 0, 1]) {
      const fb = createFramebuffer();
      renderOwnBoombox(fb, true, 0, sway);
      const limit = sway === 0 ? Math.ceil(OWN_BOOMBOX_RIGHT * W) : 0.9 * W;
      expect(Math.max(...drawnColumns(fb.pixels))).toBeLessThan(limit);
    }
  });

  test('it never overlaps the resting drink', () => {
    const drink = createFramebuffer();
    renderOwnHeld(drink, 'beer', 0, 0, 0);
    const box = createFramebuffer();
    renderOwnBoombox(box, true, 0, 0);
    expect(drink.pixels.some((c, i) => c !== 0 && box.pixels[i] !== 0)).toBe(false);
  });

  test('walking drops it with the bob and sways it opposite to the drink', () => {
    const fb = createFramebuffer();
    renderOwnBoombox(fb, true, 1, 1);
    expect(fb.pixels[at(7, 1, 1, 1)]).toBe(tex(7, 1));
    expect(at(7, 1, 1, 1) % W).toBeLessThan(at(7, 1) % W);
  });
});
