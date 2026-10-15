import { describe, expect, test } from 'vitest';
import { FACE_SIZE } from '../media/faces';
import { rgb } from './framebuffer';
import { GLOW_RADIUS, GLOW_STRENGTH, type Glow, glowLight, glowOf } from './glow';

describe('glowOf', () => {
  test('a face glows its average colour, scaled to GLOW_STRENGTH', () => {
    const face = new Uint32Array(FACE_SIZE * FACE_SIZE).fill(rgb(255, 128, 0));
    const g: Glow = { x: 0, y: 0, r: 0, g: 0, b: 0 };
    glowOf(2, 3, face, rgb(0, 0, 255), g);
    expect([g.x, g.y]).toEqual([2, 3]);
    expect(g.r).toBeCloseTo(GLOW_STRENGTH, 2);
    expect(g.g).toBeCloseTo(GLOW_STRENGTH * (128 / 255), 2);
    expect(g.b).toBe(0);
  });

  test('a disc without a face glows its ring colour', () => {
    const g: Glow = { x: 0, y: 0, r: 0, g: 0, b: 0 };
    glowOf(0, 0, null, rgb(0, 0, 255), g);
    expect([g.r, g.g, g.b]).toEqual([0, 0, GLOW_STRENGTH]);
  });
});

describe('glowLight', () => {
  const g: Glow = { x: 0, y: 0, r: 1, g: 1, b: 1 };

  test('the floor under the disc gets the most, fading to nothing at GLOW_RADIUS', () => {
    const under = glowLight(g, 0, 0, 0, 0, 0, 1);
    expect(under).toBeGreaterThan(glowLight(g, 0.8, 0, 0, 0, 0, 1));
    expect(glowLight(g, GLOW_RADIUS, 0, 0, 0, 0, 1)).toBe(0);
  });

  test('a wall facing away from the disc gets none', () => {
    // A wall at x = 0.5 facing +x, the disc on its back side.
    expect(glowLight(g, 0.5, 0, 0.5, 1, 0, 0)).toBe(0);
    expect(glowLight(g, 0.5, 0, 0.5, -1, 0, 0)).toBeGreaterThan(0);
  });
});
