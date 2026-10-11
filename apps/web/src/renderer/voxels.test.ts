import type { PlayerState } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createFramebuffer, rgb } from './framebuffer';
import { VACUUM_MODEL } from './models/vacuum';
import { renderSprites, type Sprite } from './sprites';
import { buildModel, renderVoxel, type VoxelInstance } from './voxels';

// Voxel objects (robot vacuum spec §6): models described in code, drawn depth-correct among walls and discs.
const player: PlayerState = { x: 1.5, y: 4.5, angle: 0 };
const RED = rgb(200, 10, 10);
const scaled = (c: number, k: number) =>
  rgb(((c & 0xff) * k) | 0, (((c >>> 8) & 0xff) * k) | 0, (((c >>> 16) & 0xff) * k) | 0);

function blank() {
  const fb = createFramebuffer();
  fb.zbuffer.fill(Number.POSITIVE_INFINITY);
  return fb;
}

const disc = (x: number): Sprite => ({
  key: 'd',
  x,
  y: 4.5,
  color: rgb(10, 200, 10),
  face: null,
  speaking: 0,
  bob: 0,
  itemBob: 0,
  sip: 0,
  cheers: 0,
  wobble: 0,
  held: null,
  boombox: false,
});
const robot = (x: number, angle = 0): VoxelInstance => ({ model: VACUUM_MODEL, x, y: 4.5, angle });

describe('buildModel', () => {
  test('exposes only faces with an empty neighbour, never the bottom', () => {
    const m = buildModel(2, 1, 1, 0.1, () => RED);
    // 2 tops + 1 front + 1 back + 2 left + 2 right; the shared inner faces and the bottoms are absent.
    expect(m.faceCount).toBe(8);
    expect(m.corners).toHaveLength(8 * 12);
  });

  test('shades faces 1.0 on top, 0.8 front and back, 0.62 at the sides', () => {
    const m = buildModel(1, 1, 1, 0.1, () => RED);
    const byNormal = new Map<string, number>();
    for (let f = 0; f < m.faceCount; f++) {
      const n = [m.normals[f * 3], m.normals[f * 3 + 1], m.normals[f * 3 + 2]].join(',');
      byNormal.set(n, m.colors[f] as number);
    }
    expect(byNormal.get('0,0,1')).toBe(RED);
    expect(byNormal.get('1,0,0')).toBe(scaled(RED, 0.8));
    expect(byNormal.get('-1,0,0')).toBe(scaled(RED, 0.8));
    expect(byNormal.get('0,1,0')).toBe(scaled(RED, 0.62));
    expect(byNormal.get('0,-1,0')).toBe(scaled(RED, 0.62));
    expect(m.shadowRadius).toBeCloseTo(0.05);
  });
});

describe('the vacuum model', () => {
  test('is 0.7 × 0.7 × 0.2 tiles and flat at the front', () => {
    const c = VACUUM_MODEL.corners;
    const axis = (k: number) => Array.from({ length: c.length / 3 }, (_, i) => c[i * 3 + k] as number);
    expect(Math.max(...axis(0))).toBeCloseTo(0.3);
    expect(Math.min(...axis(0))).toBeCloseTo(-0.35);
    expect(Math.max(...axis(1))).toBeCloseTo(0.35);
    expect(Math.min(...axis(1))).toBeCloseTo(-0.35);
    expect(Math.max(...axis(2))).toBeCloseTo(0.2);
    expect(VACUUM_MODEL.shadowRadius).toBeCloseTo(0.35);
  });

  test('its eyes face the front (+x)', () => {
    const eye = scaled(rgb(0xff, 0xff, 0xd2), 0.8);
    const front = [];
    for (let f = 0; f < VACUUM_MODEL.faceCount; f++) {
      if (VACUUM_MODEL.normals[f * 3] === 1) {
        front.push(VACUUM_MODEL.colors[f]);
      }
    }
    expect(front).toContain(eye);
  });
});

describe('renderVoxel', () => {
  test('draws a vacuum 2 tiles ahead, below the horizon', () => {
    const fb = blank();
    renderVoxel(fb, player, robot(3.5));
    const rows = new Set<number>();
    fb.pixels.forEach((px, i) => {
      if (px !== 0) {
        rows.add(Math.floor(i / fb.width));
      }
    });
    expect(rows.size).toBeGreaterThan(10);
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(fb.height / 2);
  });

  test('voxel faces are depth-tested against walls', () => {
    const fb = blank();
    fb.zbuffer.fill(1);
    renderVoxel(fb, player, robot(3.5));
    expect(fb.pixels.every((px) => px === 0)).toBe(true);
  });

  test('turning the robot changes what is drawn', () => {
    const a = blank();
    const b = blank();
    renderVoxel(a, player, robot(3.5, 0));
    renderVoxel(b, player, robot(3.5, Math.PI / 2));
    expect(a.pixels).not.toEqual(b.pixels);
  });

  test('draws nothing for a robot behind the camera', () => {
    const fb = blank();
    renderVoxel(fb, player, robot(0.5));
    expect(fb.pixels.every((px) => px === 0)).toBe(true);
  });
});

describe('renderSprites with voxels', () => {
  /** Pixels a render changes from blank, by index. */
  const painted = (fb: ReturnType<typeof blank>) => {
    const out = new Map<number, number>();
    fb.pixels.forEach((px, i) => {
      if (px !== 0) {
        out.set(i, px);
      }
    });
    return out;
  };

  test('a nearer disc covers the robot', () => {
    const discOnly = blank();
    renderSprites(discOnly, player, [disc(3.0)]);
    const both = blank();
    renderSprites(both, player, [disc(3.0)], undefined, [robot(4.0)]);
    const robotOnly = blank();
    renderSprites(robotOnly, player, [], undefined, [robot(4.0)]);
    const shownDisc = painted(discOnly);
    // The disc wins every pixel it paints, and the robot really was behind some of them.
    for (const [i, px] of shownDisc) {
      expect(both.pixels[i]).toBe(px);
    }
    const overlap = [...painted(robotOnly).keys()].filter((i) => shownDisc.has(i));
    expect(overlap.length).toBeGreaterThan(0);
  });

  test('a nearer robot covers the disc', () => {
    const discOnly = blank();
    renderSprites(discOnly, player, [disc(4.0)]);
    const both = blank();
    renderSprites(both, player, [disc(4.0)], undefined, [robot(3.9)]);
    const changed = [...painted(discOnly)].filter(([i, px]) => both.pixels[i] !== px);
    expect(changed.length).toBeGreaterThan(0);
  });
});
