import { describe, expect, test } from 'vitest';
import { rgb } from './framebuffer';
import { averageColour, makeTextures, RELIEF, RELIEF_LEVELS, TEX } from './textures';

const at = (tile: number, x: number, y: number) =>
  RELIEF_LEVELS[(RELIEF[tile] as Uint8Array)[y * TEX + x] as number] as number;

describe('RELIEF', () => {
  test('one map per texture, TEX² texels each', () => {
    expect(RELIEF).toHaveLength(makeTextures(1).length);
    for (const r of RELIEF.slice(1)) {
      expect(r).toHaveLength(TEX * TEX);
    }
  });

  test('stone bricks catch the light on top, darken at the bottom and shade the mortar under them', () => {
    // Column 8 crosses no vertical mortar; mortar rows are 0–1, 16–17, 32–33, 48–49.
    expect(at(1, 8, 2)).toBeGreaterThan(0);
    expect(at(1, 8, 15)).toBeLessThan(0);
    expect(at(1, 8, 16)).toBeLessThan(0);
    expect(at(1, 8, 16)).toBeGreaterThan(at(1, 8, 15));
    // Mid-brick, and mortar not right under a brick, are flat.
    expect(at(1, 8, 8)).toBe(0);
    expect(at(1, 8, 17)).toBe(0);
  });

  test('blue stone shares the brick pattern; wood has no relief', () => {
    expect([...(RELIEF[3] as Uint8Array)]).toEqual([...(RELIEF[1] as Uint8Array)]);
    expect((RELIEF[2] as Uint8Array).every((v) => RELIEF_LEVELS[v] === 0)).toBe(true);
  });
});

describe('averageColour', () => {
  test('is the mean of every texel, rounded', () => {
    const tex = Uint32Array.from([rgb(0, 10, 255), rgb(255, 11, 0)]);
    expect(averageColour(tex)).toBe(rgb(128, 11, 128));
  });
});
