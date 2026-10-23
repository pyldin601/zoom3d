import { type PlayerState, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createView, setView } from './camera';
import { createFramebuffer, rgb } from './framebuffer';
import { bakeLighting, type Light } from './lighting';
import { VACUUM_MODEL } from './models/vacuum';
import { renderSprites, type Sprite } from './sprites';
import { buildModel, glowing, renderVoxel, type VoxelInstance } from './voxels';

// Voxel objects (robot vacuum spec §6): models described in code, drawn depth-correct among walls and discs.
const player: PlayerState = { x: 1.5, y: 4.5, angle: 0 };
/** The player's view of a default-size frame, which every test here draws into. */
const view = setView(createView(), createFramebuffer(), player);
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
    const m = buildModel({ x: 2, y: 1, z: 1 }, 0.1, () => RED);
    // 2 tops + 1 front + 1 back + 2 left + 2 right; the shared inner faces and the bottoms are absent.
    expect(m.faceCount).toBe(8);
    expect(m.corners).toHaveLength(8 * 12);
  });

  test('shades faces 1.0 on top, 0.8 front and back, 0.62 at the sides', () => {
    const m = buildModel({ x: 1, y: 1, z: 1 }, 0.1, () => RED);
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

describe('glowing voxels', () => {
  test("buildModel keeps each face's glow; plain colours get none", () => {
    const m = buildModel({ x: 2, y: 1, z: 1 }, 0.1, (x) => (x === 0 ? RED : glowing(RED, 0.75)));
    const byX = new Map<number, Set<number>>();
    for (let f = 0; f < m.faceCount; f++) {
      const x = Math.min(m.corners[f * 12] as number, m.corners[f * 12 + 3] as number) < 0 ? 0 : 1;
      byX.set(x, (byX.get(x) ?? new Set()).add(m.glow[f] as number));
    }
    expect(byX.get(0)).toEqual(new Set([0]));
    expect(byX.get(1)).toEqual(new Set([0.75]));
  });

  test('a glowing voxel keeps its colour in the plain (unlit) shading', () => {
    const m = buildModel({ x: 1, y: 1, z: 1 }, 0.1, () => glowing(RED, 1));
    const plain = buildModel({ x: 1, y: 1, z: 1 }, 0.1, () => RED);
    expect([...m.colors]).toEqual([...plain.colors]);
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

  test('its eyes and the disc on top glow; nothing else does', () => {
    const glowingColours = new Set<number>();
    for (let f = 0; f < VACUUM_MODEL.faceCount; f++) {
      if ((VACUUM_MODEL.glow[f] as number) > 0) {
        glowingColours.add(VACUUM_MODEL.base[f] as number);
        expect(VACUUM_MODEL.glow[f]).toBe(1);
      }
    }
    expect(glowingColours).toEqual(new Set([rgb(0xff, 0xff, 0xd2), rgb(0xfa, 0xd2, 0x50)]));
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
    renderVoxel(fb, view, robot(3.5));
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
    renderVoxel(fb, view, robot(3.5));
    expect(fb.pixels.every((px) => px === 0)).toBe(true);
  });

  test('turning the robot changes what is drawn', () => {
    const a = blank();
    const b = blank();
    renderVoxel(a, view, robot(3.5, 0));
    renderVoxel(b, view, robot(3.5, Math.PI / 2));
    expect(a.pixels).not.toEqual(b.pixels);
  });

  test('draws nothing for a robot behind the camera', () => {
    const fb = blank();
    renderVoxel(fb, view, robot(0.5));
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
    renderSprites(discOnly, { eye: player, people: [disc(3.0)], objects: [], lighting: null });
    const both = blank();
    renderSprites(both, { eye: player, people: [disc(3.0)], objects: [robot(4.0)], lighting: null });
    const robotOnly = blank();
    renderSprites(robotOnly, { eye: player, people: [], objects: [robot(4.0)], lighting: null });
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
    renderSprites(discOnly, { eye: player, people: [disc(4.0)], objects: [], lighting: null });
    const both = blank();
    renderSprites(both, { eye: player, people: [disc(4.0)], objects: [robot(3.9)], lighting: null });
    const changed = [...painted(discOnly)].filter(([i, px]) => both.pixels[i] !== px);
    expect(changed.length).toBeGreaterThan(0);
  });
});

describe('renderVoxel with lighting', () => {
  // Open floor round the player and the robot at (3.5, 4.5).
  const room = parseMap(`
1111111
1.....1
1.....1
1.....1
1S....1
1.....1
1111111
`);
  const cube = buildModel({ x: 1, y: 1, z: 1 }, 0.2, () => RED);
  const box: VoxelInstance = { model: cube, x: 3.5, y: 4.5, angle: Math.PI };
  const drawn = (fb: ReturnType<typeof blank>) => new Set([...fb.pixels].filter((px) => px !== 0));
  const lamp: Light = { x: 3.5, y: 4.5, z: 0.85, radius: 4, r: 1, g: 1, b: 1 };

  test('with no lamps, faces get only the ambient share of their usual shade', () => {
    const fb = blank();
    renderVoxel(fb, view, box, bakeLighting(room, [], 0.45, RED, RED));
    // The top and the face turned to the camera.
    expect(drawn(fb)).toEqual(new Set([scaled(RED, 0.45), scaled(RED, 0.45 * 0.8)]));
  });

  test('a lamp overhead brightens the top', () => {
    const dark = blank();
    renderVoxel(dark, view, box, bakeLighting(room, [], 0.45, RED, RED));
    const lit = blank();
    renderVoxel(lit, view, box, bakeLighting(room, [lamp], 0.45, RED, RED));
    const red = (fb: ReturnType<typeof blank>) => Math.max(...[...drawn(fb)].map((c) => c & 0xff));
    expect(red(lit)).toBeGreaterThan(red(dark));
  });

  test('a fully glowing voxel shows its own colour on every face, whatever the light', () => {
    const lit = (l: Light[]) => {
      const fb = blank();
      const model = buildModel({ x: 1, y: 1, z: 1 }, 0.2, () => glowing(RED, 1));
      renderVoxel(fb, view, { ...box, model }, bakeLighting(room, l, 0.45, RED, RED));
      return drawn(fb);
    };
    expect(lit([])).toEqual(new Set([RED]));
    expect(lit([lamp])).toEqual(new Set([RED]));
  });

  test('half a glow is halfway between lit and its own colour', () => {
    const fb = blank();
    const model = buildModel({ x: 1, y: 1, z: 1 }, 0.2, () => glowing(RED, 0.5));
    renderVoxel(fb, view, { ...box, model }, bakeLighting(room, [], 0.45, RED, RED));
    // Top: 0.45 × 0.5 + 0.5; the face to the camera: 0.45 × 0.8 × 0.5 + 0.5.
    expect(drawn(fb)).toEqual(new Set([scaled(RED, 0.725), scaled(RED, 0.68)]));
  });

  describe('shine (ball: dark patches seen in the dark)', () => {
    const GREY = rgb(60, 60, 60);
    const shiningCube = () => {
      const model = buildModel({ x: 1, y: 1, z: 1 }, 0.2, () => RED);
      model.shine.fill(GREY);
      return model;
    };
    const drawnIn = (model: ReturnType<typeof shiningCube>, ambient: number) => {
      const fb = blank();
      renderVoxel(fb, view, { ...box, model }, bakeLighting(room, [], ambient, RED, RED));
      return drawn(fb);
    };

    test('plain models have none', () => {
      expect(cube.shine.every((c) => c === 0)).toBe(true);
    });

    test('in a pitch-dark room a face shows its whole shine', () => {
      expect(drawnIn(shiningCube(), 0)).toEqual(new Set([GREY]));
    });

    test('in full light the top shows no shine at all', () => {
      expect(drawnIn(shiningCube(), 1)).toContain(RED);
    });

    test('in between, the darker a face the more it shines', () => {
      // Top: lit 0.45, shine × 0.55; the face to the camera: lit 0.36, shine × 0.64.
      const shined = (c: number, k: number) =>
        rgb(
          ((c & 0xff) * k + 60 * (1 - k)) | 0,
          (((c >>> 8) & 0xff) * k + 60 * (1 - k)) | 0,
          (((c >>> 16) & 0xff) * k + 60 * (1 - k)) | 0
        );
      expect(drawnIn(shiningCube(), 0.45)).toEqual(new Set([shined(RED, 0.45), shined(RED, 0.45 * 0.8)]));
    });

    test('the plain (unlit) shading ignores it', () => {
      const fb = blank();
      renderVoxel(fb, view, { ...box, model: shiningCube() }, null);
      expect(drawn(fb)).toEqual(new Set([RED, scaled(RED, 0.8)]));
    });
  });

  test('renderSprites passes the lighting on to voxels', () => {
    const fb = blank();
    renderSprites(fb, { eye: player, people: [], objects: [box], lighting: bakeLighting(room, [], 0.45, RED, RED) });
    expect(drawn(fb).has(scaled(RED, 0.45))).toBe(true);
  });
});
