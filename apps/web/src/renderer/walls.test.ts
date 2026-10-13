import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createFramebuffer, DEFAULT_FOV } from './framebuffer';
import { bakeLighting, GLINT_RANGE } from './lighting';
import { makeTextures, TEX } from './textures';
import { CEILING, FLOOR, renderWalls, shade } from './walls';

const ROOM = parseMap('11111\n1...1\n1.S.1\n1...1\n11111');
const PROJ = 320 / Math.tan(DEFAULT_FOV / 2);
const textures = makeTextures(1);

function column(fb: ReturnType<typeof createFramebuffer>, x: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < fb.height; y++) {
    out.push(fb.pixels[y * fb.width + x] as number);
  }
  return out;
}

function textureColumn(tile: number, texX: number): number[] {
  const tex = textures[tile] as Uint32Array;
  return Array.from({ length: TEX }, (_, y) => tex[y * TEX + texX] as number);
}

describe('renderWalls', () => {
  const fb = createFramebuffer();
  renderWalls(fb, ROOM, { x: 2.5, y: 2.5, angle: 0 }, textures);

  test('framebuffer is 640x360 with a per-column z-buffer', () => {
    expect([fb.width, fb.height, fb.zbuffer.length]).toEqual([640, 360, 640]);
  });

  test('centre column distance is the perpendicular wall distance', () => {
    expect(fb.zbuffer[320]).toBeCloseTo(1.5);
  });

  test('centre column wall height is PROJ / distance', () => {
    const wall = column(fb, 320).filter((c) => c !== CEILING && c !== FLOOR).length;
    expect(Math.abs(wall - PROJ / 1.5)).toBeLessThanOrEqual(2);
  });

  test('ceiling above and floor below the walls', () => {
    expect(fb.pixels[0]).toBe(CEILING);
    expect(fb.pixels[fb.pixels.length - 1]).toBe(FLOOR);
  });

  test('every pixel is opaque', () => {
    expect(fb.pixels.every((c) => c >>> 24 === 0xff)).toBe(true);
  });

  test('x-side walls use unshaded texels (column mirrored when facing +x)', () => {
    const allowed = new Set(textureColumn(1, TEX - 32 - 1));
    const wall = column(fb, 320).filter((c) => c !== CEILING && c !== FLOOR);
    expect(wall.every((c) => allowed.has(c))).toBe(true);
  });

  test('y-side walls are shaded', () => {
    const south = createFramebuffer();
    renderWalls(south, ROOM, { x: 2.5, y: 2.5, angle: Math.PI / 2 }, textures);
    const allowed = new Set(textureColumn(1, 32).map(shade));
    const wall = column(south, 320).filter((c) => c !== CEILING && c !== FLOOR);
    expect(wall.length).toBeGreaterThan(300);
    expect(wall.every((c) => allowed.has(c))).toBe(true);
  });
});

describe('shade', () => {
  test('scales channels to 70% and keeps alpha', () => {
    expect(shade(0xff6464c8)).toBe(0xff4646_8c);
  });
});

describe('makeTextures', () => {
  test('is deterministic', () => {
    expect(makeTextures(1)).toEqual(makeTextures(1));
  });

  test('has three distinct 64x64 opaque wall textures', () => {
    expect(textures.slice(1).map((t) => t.length)).toEqual([TEX * TEX, TEX * TEX, TEX * TEX]);
    expect(textures[1]).not.toEqual(textures[2]);
    expect(textures[2]).not.toEqual(textures[3]);
    expect(textures.slice(1).every((t) => t.every((c) => c >>> 24 === 0xff))).toBe(true);
  });
});

test('a narrower FOV draws the same wall taller', () => {
  const player = { x: 2.5, y: 2.5, angle: 0 };
  const wide = createFramebuffer(296, 640, (66 * Math.PI) / 180);
  const narrow = createFramebuffer(296, 640, (50 * Math.PI) / 180);
  renderWalls(wide, ROOM, player, textures);
  renderWalls(narrow, ROOM, player, textures);
  const wallHeight = (fb: ReturnType<typeof createFramebuffer>) =>
    column(fb, 148).filter((c) => c !== CEILING && c !== FLOOR).length;
  expect(wallHeight(narrow)).toBeGreaterThan(wallHeight(wide));
  expect(wallHeight(narrow) / wallHeight(wide)).toBeCloseTo(
    Math.tan((33 * Math.PI) / 180) / Math.tan((25 * Math.PI) / 180),
    1
  );
});

describe('renderWalls glint', () => {
  // A corridor with a lamp near its east end.
  const corridor = parseMap('1111111111\n1S.......1\n1111111111');
  const lit = bakeLighting(
    corridor,
    [{ x: 6.5, y: 1.5, z: 0.85, radius: 4.5, r: 1, g: 1, b: 1 }],
    0.45,
    FLOOR,
    CEILING
  );
  const matte = { ...lit, wallLamp: new Int16Array(lit.wallLamp.length).fill(-1) };
  const render = (x: number, lighting: typeof lit) => {
    const fb = createFramebuffer();
    renderWalls(fb, corridor, { x, y: 1.5, angle: 0 }, textures, lighting);
    return fb;
  };
  const channels = (c: number) => [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff];

  test('brightens a near wall where it mirrors the lamp, never darkens', () => {
    const glinted = render(7.5, lit).pixels;
    const plain = render(7.5, matte).pixels;
    let brighter = 0;
    for (let i = 0; i < plain.length; i++) {
      const a = channels(glinted[i] as number);
      const b = channels(plain[i] as number);
      expect(a.every((v, k) => v >= (b[k] as number))).toBe(true);
      if (a.some((v, k) => v > (b[k] as number))) {
        brighter++;
      }
    }
    expect(brighter).toBeGreaterThan(0);
  });

  test('leaves walls past GLINT_RANGE alone', () => {
    // Looking down the corridor: the end wall is far, the side walls near the edges are close.
    const glinted = render(1.5, lit);
    const plain = render(1.5, matte);
    let far = 0;
    for (let col = 0; col < plain.width; col++) {
      if ((plain.zbuffer[col] as number) < GLINT_RANGE) {
        continue;
      }
      far++;
      const differs = column(glinted, col).some((c, y) => c !== plain.pixels[y * plain.width + col]);
      expect(differs).toBe(false);
    }
    expect(far).toBeGreaterThan(0);
  });
});
