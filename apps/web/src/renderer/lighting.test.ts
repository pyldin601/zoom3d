import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { rgb } from './framebuffer';
import { bakeLighting, DIR_BACK, DIR_FRONT, DIR_TOP, directLight, type Light } from './lighting';
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
