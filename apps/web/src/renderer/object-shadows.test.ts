import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { rgb } from './framebuffer';
import { bakeLighting, FLOOR_SUB, floorLampLight, type Light } from './lighting';
import { objectSeenShare, shadowReach } from './object-shadows';
import { buildModel, type VoxelInstance } from './voxels';

// Voxel shadows spec §3.2: how much of a lamp's disc the floor sees past an object.
const GREY = rgb(0x70, 0x70, 0x70);
const lamp: Light = { x: 5, y: 5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 };
/** 8 × 8 × 8 voxels of 0.05: 0.4 tiles on a side, as tall as the ball. */
const BLOCK = buildModel({ x: 8, y: 8, z: 8 }, 0.05, () => GREY);
const block: VoxelInstance = { model: BLOCK, x: 6, y: 5, angle: 0 };

describe('objectSeenShare', () => {
  test('a point on the lamp’s side sees all of it', () => {
    expect(objectSeenShare(block, lamp, 5.5, 5)).toBe(1);
  });

  test('a point just behind the object sees none of it', () => {
    expect(objectSeenShare(block, lamp, 6.3, 5)).toBe(0);
  });

  test('a point beyond the shadow’s tip sees all of it', () => {
    expect(objectSeenShare(block, lamp, 6 + shadowReach(block, lamp) + 0.1, 5)).toBe(1);
  });

  test('the shadow points away from the lamp', () => {
    const east = { ...lamp, x: 7 };
    expect(objectSeenShare(block, east, 6.3, 5)).toBe(1);
    expect(objectSeenShare(block, east, 5.7, 5)).toBe(0);
  });

  test('the penumbra across the shadow’s side is monotonic, and soft', () => {
    const shares = Array.from({ length: 51 }, (_, i) => objectSeenShare(block, lamp, 6.6, 5 + i * 0.02));
    for (let i = 1; i < shares.length; i++) {
      expect(shares.at(i)).toBeGreaterThanOrEqual(shares.at(i - 1) ?? 0);
    }
    expect(shares.some((s) => s > 0 && s < 1)).toBe(true);
    expect(shares.at(0)).toBe(0);
    expect(shares.at(-1)).toBe(1);
  });

  test('the tip is soft too', () => {
    const reach = shadowReach(block, lamp);
    const shares = Array.from({ length: 60 }, (_, i) => objectSeenShare(block, lamp, 6.2 + (i * reach) / 60, 5));
    expect(shares.some((s) => s > 0 && s < 1)).toBe(true);
  });

  test('turning the object turns its shadow', () => {
    // 0.1 deep, 0.5 wide, 0.5 tall: across the lamp's light at angle 0, along it at a quarter turn.
    const slab = buildModel({ x: 2, y: 10, z: 10 }, 0.05, () => GREY);
    const across = objectSeenShare({ model: slab, x: 6, y: 5, angle: 0 }, lamp, 6.4, 5.2);
    const along = objectSeenShare({ model: slab, x: 6, y: 5, angle: Math.PI / 2 }, lamp, 6.4, 5.2);
    expect(across).toBe(0);
    expect(along).toBeGreaterThan(0.5);
  });

  test('an object right under the lamp shades the floor round it', () => {
    const under = { ...block, x: 5, y: 5 };
    const share = objectSeenShare(under, lamp, 5.25, 5);
    expect(share).toBeLessThan(1);
    expect(share).toBeGreaterThan(0);
    expect(Number.isNaN(objectSeenShare(under, lamp, 5, 5))).toBe(false);
  });
});

describe('floorLampLight', () => {
  test('is what the bake lights an open floor cell with', () => {
    const room = parseMap('11111111111\n1S........1\n1.........1\n1.........1\n11111111111');
    const l = { ...lamp, x: 4.5, y: 2.5 };
    const lm = bakeLighting(room, [l], 0, GREY, GREY);
    for (const [px, py] of [
      [4.5625, 2.5625],
      [6.0625, 1.9375],
      [7.3125, 3.4375],
    ] as const) {
      const cell = Math.floor(py * FLOOR_SUB) * lm.stride + Math.floor(px * FLOOR_SUB);
      expect((lm.floor[cell] as number) & 0xff).toBe(Math.min(255, Math.round(0x70 * floorLampLight(l, px, py))));
    }
  });
});
