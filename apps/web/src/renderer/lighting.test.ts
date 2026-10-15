import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { rgb } from './framebuffer';
import {
  bakeLighting,
  brightestGlint,
  DIR_BACK,
  DIR_FRONT,
  DIR_TOP,
  directLight,
  GLINT_LAMPS,
  glint,
  type Light,
  streak,
  WALL_U,
  WALL_V,
} from './lighting';
import { RELIEF_LEVELS } from './textures';

// A 6×3 room with a pillar at (3, 1) splitting it into a west and an east half along the middle row.
const map = parseMap(`
1111111
1S.1..1
1.....1
1111111
`);
const GREY = rgb(100, 100, 100);
const lamp = (x: number, y: number): Light => ({ x, y, z: 0.85, radius: 4, r: 1, g: 1, b: 1 });

describe('directLight', () => {
  test('is zero everywhere with no lamps', () => {
    const lm = bakeLighting(map, [], 0.45, GREY, GREY);
    const out = new Float64Array(15).fill(9);
    directLight(lm, 1.5, 2.5, 0.1, 0, out);
    expect([...out]).toEqual(new Array(15).fill(0));
  });

  test('a lamp overhead lights the top more than the sides', () => {
    const lm = bakeLighting(map, [lamp(1.6, 2.5)], 0.45, GREY, GREY);
    const out = new Float64Array(15);
    directLight(lm, 1.5, 2.5, 0.1, 0, out);
    expect(out[DIR_TOP * 3] as number).toBeGreaterThan(0.5);
    expect(out[DIR_TOP * 3] as number).toBeGreaterThan(out[DIR_FRONT * 3] as number);
  });

  test('lights the face turned towards the lamp, not the one turned away', () => {
    const lm = bakeLighting(map, [lamp(4.5, 2.5)], 0.45, GREY, GREY);
    const out = new Float64Array(15);
    // Facing east (+x), the lamp is ahead: the front is lit, the back is not.
    directLight(lm, 2.5, 2.5, 0.1, 0, out);
    expect(out[DIR_FRONT * 3] as number).toBeGreaterThan(0);
    expect(out[DIR_BACK * 3]).toBe(0);
    // Turned round, it's the back that faces the lamp.
    directLight(lm, 2.5, 2.5, 0.1, Math.PI, out);
    expect(out[DIR_FRONT * 3]).toBe(0);
    expect(out[DIR_BACK * 3] as number).toBeGreaterThan(0);
  });

  test('a wall between the object and the lamp leaves it unlit', () => {
    const lm = bakeLighting(map, [lamp(4.5, 1.5)], 0.45, GREY, GREY);
    const out = new Float64Array(15);
    directLight(lm, 2.5, 1.5, 0.1, 0, out);
    expect([...out]).toEqual(new Array(15).fill(0));
  });

  test('a lamp out of reach leaves it unlit', () => {
    const lm = bakeLighting(map, [{ ...lamp(5.5, 2.5), radius: 1 }], 0.45, GREY, GREY);
    const out = new Float64Array(15);
    directLight(lm, 1.5, 2.5, 0.1, 0, out);
    expect([...out]).toEqual(new Array(15).fill(0));
  });
});

describe('bakeLighting relief levels', () => {
  const levels = RELIEF_LEVELS.length;
  const channel = (v: number) => v & 0xff;

  test('every wall sample holds one light per relief level', () => {
    const lm = bakeLighting(map, [], 0.45, GREY, GREY);
    expect(lm.wall.length % levels).toBe(0);
  });

  test('without lamps, relief changes nothing', () => {
    const lm = bakeLighting(map, [], 0.45, GREY, GREY);
    for (let s = 0; s < lm.wall.length; s += levels) {
      expect(new Set(lm.wall.subarray(s, s + levels))).toEqual(new Set([lm.wall[s]]));
    }
  });

  test('under a lamp, raised texels get more light and sunken ones less', () => {
    const lm = bakeLighting(map, [lamp(2.5, 2.5)], 0.45, GREY, GREY);
    let lit = 0;
    for (let s = 0; s < lm.wall.length; s += levels) {
      const flat = channel(lm.wall[s] as number);
      const at = (k: number) => channel(lm.wall[s + k] as number);
      const raised = RELIEF_LEVELS.findIndex((v) => v > 0);
      const sunken = RELIEF_LEVELS.findIndex((v) => v < 0);
      // Too little lamp light rounds away; look where it clearly shows.
      if (at(raised) >= flat + 4) {
        lit++;
        expect(at(sunken)).toBeLessThan(flat);
      }
    }
    expect(lit).toBeGreaterThan(0);
  });
});

describe('glint', () => {
  // A wall face on the plane x = 0, facing +x; the eye is at its height (0.5), 2 tiles out.
  const l = lamp(1, 2);
  const at = (y: number, z: number) => glint(l, 1, 0, 0, y, z, 2, 0);
  // Mirror the eye through the wall to (−2, 0, 0.5): the line from there to the lamp crosses x = 0 a third of the way.
  const mirrorY = 4 / 3;
  const mirrorZ = 0.5 + (0.85 - 0.5) * (2 / 3);

  test('at the mirror point it is the full falloff, over twice the lamp’s reach', () => {
    const d2 = 1 + (2 - mirrorY) ** 2 + (0.85 - mirrorZ) ** 2;
    expect(at(mirrorY, mirrorZ)).toBeCloseTo((1 - d2 / 64) ** 2, 5);
  });

  test('fades away from the mirror point, sideways and vertically', () => {
    const peak = at(mirrorY, mirrorZ);
    expect(at(mirrorY + 0.3, mirrorZ)).toBeLessThan(peak / 2);
    expect(at(mirrorY - 0.3, mirrorZ)).toBeLessThan(peak / 2);
    expect(at(mirrorY, mirrorZ - 0.3)).toBeLessThan(peak / 2);
  });

  test('is zero for a lamp behind the wall or out of reach', () => {
    expect(glint(lamp(-1, 2), 1, 0, 0, mirrorY, mirrorZ, 2, 0)).toBe(0);
    expect(glint({ ...l, radius: 0.5 }, 1, 0, 0, mirrorY, mirrorZ, 2, 0)).toBe(0);
  });
});

describe('streak', () => {
  // A wall on the plane y = 0, facing +y. The eye stands 0.5 off it, looking along it at a lamp 5 tiles down, 1 off.
  const l = { ...lamp(5, 1), radius: 4.5 };
  const out = new Float64Array(2);
  const at = (x: number, light = l, ex = 0, ey = 0.5) => {
    streak(light, 0, 1, x, 0, ex, ey, out);
    return out[0] as number;
  };
  const height = (x: number) => {
    streak(l, 0, 1, x, 0, 0, 0.5, out);
    return out[1] as number;
  };
  // The mirror point: the line from the eye mirrored through the wall, (0, −0.5), to the lamp crosses y = 0 here.
  const mirrorX = 5 / 3;

  test('is brighter part way towards the lamp than at the mirror point', () => {
    expect(at(3.5)).toBeGreaterThan(at(mirrorX) * 1.2);
  });

  test('fades out right beside the lamp', () => {
    expect(at(5)).toBeLessThan(at(3.5) / 4);
  });

  test('is zero seen face-on, or with the lamp behind the eye', () => {
    expect(at(3.5, l, 3.5, 2)).toBe(0);
    expect(at(mirrorX, { ...l, x: -5 })).toBe(0);
  });

  test('sits at the mirror height at the mirror point, climbing towards the lamp’s height beyond it', () => {
    expect(height(mirrorX)).toBeCloseTo(0.5 + (0.85 - 0.5) / 3, 5);
    expect(height(3.5)).toBeGreaterThan(height(mirrorX));
    expect(height(3.5)).toBeLessThan(0.85);
  });
});

describe('bakeLighting glint lamps', () => {
  /** The first wallLamp slot of a cell's face (0 W, 1 E, 2 N, 3 S), at sample column u. */
  const slot = (lm: ReturnType<typeof bakeLighting>, cx: number, cy: number, face: number, u = 0) =>
    ((lm.faceOffset[(cy * lm.map.width + cx) * 4 + face] as number) / WALL_V + u) * GLINT_LAMPS;

  test('every face sample column lists lamps it can see, or −1', () => {
    // Two short lamps in the corners: walls in the middle are out of both their reflection reaches.
    const short = (x: number, y: number) => ({ ...lamp(x, y), radius: 1 });
    const lm = bakeLighting(map, [short(1.5, 1.5), short(5.5, 1.5)], 0.45, GREY, GREY);
    expect(lm.wallLamp.every((i) => i >= -1 && i < 2)).toBe(true);
    expect(lm.wallLamp[slot(lm, 3, 3, 2, WALL_U / 2)]).toBe(-1);
    expect(lm.wallLamp.some((i) => i === 0)).toBe(true);
    expect(lm.wallLamp.some((i) => i === 1)).toBe(true);
  });

  test('lists the lamps in sight nearest first, those past their light’s reach too', () => {
    const lm = bakeLighting(map, [lamp(5.5, 2.5), lamp(1.5, 2.5)], 0.45, GREY, GREY);
    // The bottom wall's top (north) face under x = 1: the west lamp is close, the east one 4 tiles off, out of its
    // light's reach (4) but not its reflection's.
    const at = slot(lm, 1, 3, 2);
    expect([...lm.wallLamp.subarray(at, at + GLINT_LAMPS)]).toEqual([1, 0, -1]);
  });

  test('a lamp hidden behind the pillar is never listed', () => {
    // The lamp sits in the east half's top row; the top wall's face over x = 1 faces it, but the pillar is between.
    const lm = bakeLighting(map, [lamp(4.5, 1.5)], 0.45, GREY, GREY);
    const behind = slot(lm, 1, 0, 3);
    expect([...lm.wallLamp.subarray(behind, behind + WALL_U * GLINT_LAMPS)]).toEqual(
      new Array(WALL_U * GLINT_LAMPS).fill(-1)
    );
  });
});

describe('brightestGlint', () => {
  const corridor = parseMap(`
1111111111
1S.......1
1........1
1111111111
`);

  test('picks the lamp you look towards along the wall, not the one beside you', () => {
    // Close to the top wall at x = 2.5, under the near lamp, looking east to the far one.
    const lm = bakeLighting(corridor, [lamp(2.5, 2.5), lamp(7.5, 2.5)], 0.45, GREY, GREY);
    const at = ((lm.faceOffset[(0 * corridor.width + 5) * 4 + 3] as number) / WALL_V) * GLINT_LAMPS;
    expect(brightestGlint(lm, at, 0, 1, 5, 1, 2.5, 1.3)).toBe(1);
  });
});
