import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { rgb } from './framebuffer';
import { bakeLighting, DIR_BACK, DIR_FRONT, DIR_TOP, directLight, glint, type Light, WALL_U, WALL_V } from './lighting';
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
  const at = (y: number, z: number) => glint(l, 1, 1, 0, 0, y, z, 2, 0);
  // Mirror the eye through the wall to (−2, 0, 0.5): the line from there to the lamp crosses x = 0 a third of the way.
  const mirrorY = 4 / 3;
  const mirrorZ = 0.5 + (0.85 - 0.5) * (2 / 3);

  test('at the mirror point it is the full lamp falloff', () => {
    const d2 = 1 + (2 - mirrorY) ** 2 + (0.85 - mirrorZ) ** 2;
    expect(at(mirrorY, mirrorZ)).toBeCloseTo((1 - d2 / 16) ** 2, 5);
  });

  test('fades away from the mirror point, sideways and vertically', () => {
    const peak = at(mirrorY, mirrorZ);
    expect(at(mirrorY + 0.3, mirrorZ)).toBeLessThan(peak / 2);
    expect(at(mirrorY - 0.3, mirrorZ)).toBeLessThan(peak / 2);
    expect(at(mirrorY, mirrorZ - 0.3)).toBeLessThan(peak / 2);
  });

  test('a low F0 all but hides a glint seen face-on', () => {
    // Eye and lamp both straight out from the point (0, 2, 0.5): the view hits the wall head-on.
    const ahead = { ...lamp(1, 2), z: 0.5 };
    const shiny = glint(ahead, 1, 1, 0, 0, 2, 0.5, 2, 2);
    expect(shiny).toBeGreaterThan(0.5);
    expect(glint(ahead, 0.1, 1, 0, 0, 2, 0.5, 2, 2)).toBeCloseTo(shiny * 0.1, 5);
  });

  test('a low F0 keeps most of a glint seen at a grazing angle', () => {
    // Eye and lamp both close to the wall, 3 tiles either side of the point: the view skims along it.
    const along = { ...lamp(0.2, 5), z: 0.5 };
    const shiny = glint(along, 1, 1, 0, 0, 2, 0.5, 0.2, -1);
    expect(shiny).toBeGreaterThan(0);
    expect(glint(along, 0.1, 1, 0, 0, 2, 0.5, 0.2, -1)).toBeGreaterThan(shiny * 0.7);
  });

  test('is zero for a lamp behind the wall or out of reach', () => {
    expect(glint(lamp(-1, 2), 1, 1, 0, 0, mirrorY, mirrorZ, 2, 0)).toBe(0);
    expect(glint({ ...l, radius: 1 }, 1, 1, 0, 0, mirrorY, mirrorZ, 2, 0)).toBe(0);
  });
});

describe('bakeLighting glint lamps', () => {
  /** The first wallLamp slot of a cell's face (0 W, 1 E, 2 N, 3 S): one slot per WALL_V lightmap samples. */
  const slot = (lm: ReturnType<typeof bakeLighting>, cx: number, cy: number, face: number) =>
    (lm.faceOffset[(cy * lm.map.width + cx) * 4 + face] as number) / WALL_V;

  test('every face sample column names a lamp it can see, or −1', () => {
    // Two short lamps in the corners: walls in the middle are out of both their reaches.
    const short = (x: number, y: number) => ({ ...lamp(x, y), radius: 2 });
    const lm = bakeLighting(map, [short(1.5, 1.5), short(5.5, 1.5)], 0.45, GREY, GREY);
    expect(lm.wallLamp.every((i) => i >= -1 && i < 2)).toBe(true);
    expect(lm.wallLamp.some((i) => i === -1)).toBe(true);
    expect(lm.wallLamp.some((i) => i === 0)).toBe(true);
    expect(lm.wallLamp.some((i) => i === 1)).toBe(true);
  });

  test('picks the lamp that lights the sample most', () => {
    const lm = bakeLighting(map, [lamp(1.5, 2.5), lamp(5.5, 2.5)], 0.45, GREY, GREY);
    // The bottom wall's top (north) faces under x = 1 and x = 5.
    expect(lm.wallLamp[slot(lm, 1, 3, 2)]).toBe(0);
    expect(lm.wallLamp[slot(lm, 5, 3, 2) + WALL_U - 1]).toBe(1);
  });

  test('a lamp hidden behind the pillar is never picked', () => {
    // The lamp sits in the east half's top row; the top wall's face over x = 1 faces it, but the pillar is between.
    const lm = bakeLighting(map, [lamp(4.5, 1.5)], 0.45, GREY, GREY);
    const behind = slot(lm, 1, 0, 3);
    expect([...lm.wallLamp.subarray(behind, behind + WALL_U)]).toEqual(new Array(WALL_U).fill(-1));
  });
});
