import { describe, expect, test } from 'vitest';
import { FACE_SIZE } from '../media/faces';
import { rgb } from './framebuffer';
import {
  createAvatarGlows,
  createPortalGlows,
  GLOW_RADIUS,
  GLOW_STRENGTH,
  type Glow,
  type GlowCut,
  glowLight,
  glowOf,
} from './glow';
import { portalHall } from './test-portals';

describe('glowOf', () => {
  test('a face glows its average colour, scaled to GLOW_STRENGTH', () => {
    const face = new Uint32Array(FACE_SIZE * FACE_SIZE).fill(rgb(255, 128, 0));
    const g: Glow = { x: 0, y: 0, r: 0, g: 0, b: 0, cut: null };
    glowOf({ x: 2, y: 3, face, color: rgb(0, 0, 255) }, g);
    expect([g.x, g.y]).toEqual([2, 3]);
    expect(g.r).toBeCloseTo(GLOW_STRENGTH, 2);
    expect(g.g).toBeCloseTo(GLOW_STRENGTH * (128 / 255), 2);
    expect(g.b).toBe(0);
  });

  test('a disc without a face glows its ring colour', () => {
    const g: Glow = { x: 0, y: 0, r: 0, g: 0, b: 0, cut: null };
    glowOf({ x: 0, y: 0, face: null, color: rgb(0, 0, 255) }, g);
    expect([g.r, g.g, g.b]).toEqual([0, 0, GLOW_STRENGTH]);
  });
});

describe('glowLight', () => {
  const g: Glow = { x: 0, y: 0, r: 1, g: 1, b: 1, cut: null };

  test('the floor under the disc gets the most, fading to nothing at GLOW_RADIUS', () => {
    const under = glowLight(g, 0, 0, 0, 0, 0, 1);
    expect(under).toBeGreaterThan(glowLight(g, 0.8, 0, 0, 0, 0, 1));
    expect(glowLight(g, GLOW_RADIUS, 0, 0, 0, 0, 1)).toBe(0);
  });

  test('the disc sits half way up: the ceiling above a point gets exactly what the floor under it does', () => {
    // walls.ts works the glow out once per floor cell for both.
    for (const [x, y] of [
      [0, 0],
      [0.7, -0.3],
      [1.9, 1.1],
    ] as const) {
      expect(glowLight(g, x, y, 1, 0, 0, -1)).toBe(glowLight(g, x, y, 0, 0, 0, 1));
    }
  });

  test('a wall facing away from the disc gets none', () => {
    // A wall at x = 0.5 facing +x, the disc on its back side.
    expect(glowLight(g, 0.5, 0, 0.5, 1, 0, 0)).toBe(0);
    expect(glowLight(g, 0.5, 0, 0.5, -1, 0, 0)).toBeGreaterThan(0);
  });
});

describe('createAvatarGlows', () => {
  const disc = (x: number, color = rgb(255, 0, 0)) => ({ x, y: 0, face: null, color });
  const self = { x: 9, y: 9, face: null, color: rgb(0, 0, 255) };

  test("one glow per disc in order, then the local player's last", () => {
    const glows = createAvatarGlows().update([disc(1), disc(2)], self);
    expect(glows.map((g) => g.x)).toEqual([1, 2, 9]);
    expect(glows.at(-1)?.b).toBe(GLOW_STRENGTH);
  });

  test("a room that grows still gets every disc once and the local player's glow once", () => {
    const avatars = createAvatarGlows();
    avatars.update([disc(1), disc(2)], self);
    const glows = avatars.update([disc(1), disc(2), disc(3)], self);
    expect(glows.map((g) => g.x)).toEqual([1, 2, 3, 9]);
    expect(new Set(glows).size).toBe(4);
  });

  test("without the local player's glow the list is just the discs", () => {
    const avatars = createAvatarGlows();
    avatars.update([disc(1)], self);
    expect(avatars.update([disc(1), disc(2)], null).map((g) => g.x)).toEqual([1, 2]);
  });

  test('frames reuse the glow objects', () => {
    const avatars = createAvatarGlows();
    const first = [...avatars.update([disc(1), disc(2)], self)];
    const second = avatars.update([disc(3), disc(4)], self);
    expect(second.every((g, i) => g === first.at(i))).toBe(true);
  });
});

describe('a glow with a cut', () => {
  const plane = { cx: 2.5, cy: 3.5, nx: 0, ny: 1 }; // front side is y < 3.5
  const glow = (cut: GlowCut | null): Glow => ({ x: 2.5, y: 2.9, r: 1, g: 1, b: 1, cut });

  test('a glow without a cut lights as before, on both sides', () => {
    expect(glowLight(glow(null), 2.5, 4.0, 0, 0, 0, 1)).toBeGreaterThan(0);
    expect(glowLight(glow(null), 2.5, 2.0, 0, 0, 0, 1)).toBeGreaterThan(0);
  });

  test('a cut glow lights its front side only', () => {
    expect(glowLight(glow(plane), 2.5, 2.0, 0, 0, 0, 1)).toBeGreaterThan(0);
    expect(glowLight(glow(plane), 2.5, 4.0, 0, 0, 0, 1)).toBe(0);
  });

  test('a point on the plane is not lit', () => {
    expect(glowLight(glow(plane), 2.5, 3.5, 0, 0, 0, 1)).toBe(0);
  });
});

describe('createPortalGlows', () => {
  test('a portal glow stands 0.6 in front of its plane, pink, brighter with the pulse', () => {
    const [g] = createPortalGlows().update(portalHall().portals, 1);
    expect(g?.x).toBeCloseTo(2.5, 9);
    expect(g?.y).toBeCloseTo(2.9, 9);
    expect(g?.cut).toEqual({ cx: 2.5, cy: 3.5, nx: 0, ny: 1 });
    const dim = createPortalGlows().update(portalHall().portals, 0.6).at(0);
    expect(dim?.r ?? 0).toBeLessThan(g?.r ?? 0);
    expect(g?.g ?? 0).toBeCloseTo((g?.r ?? 0) * 0.42, 9);
  });

  test('no portals, no portal glows', () => {
    expect(createPortalGlows().update(null, 1)).toHaveLength(0);
  });
});
