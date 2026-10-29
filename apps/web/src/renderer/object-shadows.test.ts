import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { rgb } from './framebuffer';
import { bakeLighting, bakePortalLighting, FLOOR_SUB, floorLampLight, type Light, REFLECTION_LAMPS } from './lighting';
import { objectSeenShare, shadeFloor, shadowReach } from './object-shadows';
import { portalHall } from './test-portals';
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

  test('sliding a hair past the lamp never pops the shadow on the lamp’s side', () => {
    for (const x of [4.62, 4.66, 4.7, 4.74]) {
      const under = objectSeenShare({ ...block, x: 5, y: 5 }, lamp, x, 5);
      const past = objectSeenShare({ ...block, x: 5.001, y: 5 }, lamp, x, 5);
      expect(Math.abs(past - under)).toBeLessThan(0.1);
    }
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

describe('shadeFloor', () => {
  // A long corridor with a lamp at its east end; the ball 3.9 tiles west of it, near the edge of its light's reach.
  const corridor = parseMap(
    '11111111111111111111\n1S.................1\n1..................1\n1..................1\n11111111111111111111'
  );
  const l = { ...lamp, x: 16.5, y: 2.5 };
  const lm = bakeLighting(corridor, [l], 0.3, GREY, GREY);
  const shade = (v: VoxelInstance) => {
    const tables = { floor: lm.floor.slice(), floorLampSeen: lm.floorLampSeen.slice(), touch: () => {} };
    shadeFloor(lm, [v], GREY, tables, () => true);
    return tables;
  };
  /** Each floor cell's centre in the corridor, and its slot for the lamp in the reflection lists, if listed. */
  const cells = () => {
    const out: { x: number; y: number; slot: number }[] = [];
    for (let cy = 1 * FLOOR_SUB; cy < 4 * FLOOR_SUB; cy++) {
      for (let cx = 1 * FLOOR_SUB; cx < 19 * FLOOR_SUB; cx++) {
        const first = (cy * lm.stride + cx) * REFLECTION_LAMPS;
        const k = [...Array(REFLECTION_LAMPS).keys()].find((j) => lm.floorLamp[first + j] === 0);
        if (k !== undefined) {
          out.push({ x: (cx + 0.5) / FLOOR_SUB, y: (cy + 0.5) / FLOOR_SUB, slot: first + k });
        }
      }
    }
    return out;
  };

  test('a shadow cuts the floor’s reflection of the lamp wherever the lamp lights the floor, however faintly', () => {
    const ball: VoxelInstance = { model: BLOCK, x: 12.6, y: 2.5, angle: 0 };
    const { floorLampSeen } = shade(ball);
    let cut = 0;
    for (const { x, y, slot } of cells()) {
      const share = objectSeenShare(ball, l, x, y);
      if (share < 1 && Math.hypot(x - l.x, y - l.y) < l.radius) {
        cut++;
        expect(floorLampSeen[slot]).toBeCloseTo((lm.floorLampSeen[slot] as number) * share, -0.5);
      }
    }
    expect(cut).toBeGreaterThan(10);
  });

  test('past the lamp’s light the cut fades out smoothly, never stopping at an edge', () => {
    const ball: VoxelInstance = { model: BLOCK, x: 12.0, y: 2.5, angle: 0 };
    const { floorLampSeen } = shade(ball);
    // Along the shadow's middle, its cut share of the reflection, from the ball outwards.
    const along = cells()
      .filter(({ y }) => Math.abs(y - 2.5625) < 0.01)
      .filter(({ x }) => x < 11.7)
      .sort((a, b) => b.x - a.x)
      .map(({ slot }) => 1 - (floorLampSeen[slot] as number) / (lm.floorLampSeen[slot] as number));
    expect(along.at(0)).toBeGreaterThan(0.5);
    for (let i = 1; i < along.length; i++) {
      expect(Math.abs((along.at(i) ?? 0) - (along.at(i - 1) ?? 0))).toBeLessThan(0.2);
    }
  });

  test('a copy never shades floor it cannot be seen from', () => {
    // The lamp's copy through A lies at (2.5, 5.5), behind A, beside the object; the real lamp is too short to reach
    // the floor south of the wall row, so all light it could lose there is the copy's.
    const { map: hall, portals } = portalHall();
    const plain = bakeLighting(hall, [{ ...lamp, x: 4.5, y: 1.5, radius: 2 }], 0.3, GREY, GREY);
    const lit = bakePortalLighting(plain, portals, GREY, GREY);
    const tables = { floor: lit.floor.slice(), floorLampSeen: lit.floorLampSeen.slice(), touch: () => {} };
    shadeFloor(lit, [{ model: BLOCK, x: 2.5, y: 5.0, angle: 0 }], GREY, tables, () => true);
    const southOfWallRow = 4 * FLOOR_SUB * lit.stride;
    expect(tables.floor.subarray(southOfWallRow)).toEqual(lit.floor.subarray(southOfWallRow));
  });
});
