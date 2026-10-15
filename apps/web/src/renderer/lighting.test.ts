import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { rgb } from './framebuffer';
import {
  ambientAt,
  bakeLighting,
  bounceHeight,
  brightestReflection,
  DIR_BACK,
  DIR_FRONT,
  DIR_TOP,
  directLight,
  FLOOR_SUB,
  type Light,
  REFLECTION_LAMPS,
  reflection,
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

describe('reflection', () => {
  // A wall on the plane y = 0, facing +y. A lamp 1 off it at x = 5.
  const l = { ...lamp(5, 1), radius: 4.5 };
  const WOOD = { shininess: 16, f0: 0.4 };
  const BRICK = { shininess: 8, f0: 0.05 };
  /** The brightest it gets up and down the wall's column at x, seen from the eye at (ex, ey). */
  const peak = (x: number, ex: number, ey: number, m = WOOD, light: Light = l) => {
    let most = 0;
    for (let z = 0; z <= 1; z += 0.01) {
      most = Math.max(most, reflection(light, m.shininess, m.f0, 0, 1, 0, x, 0, z, ex, ey));
    }
    return most;
  };
  // Face-on: the eye 1.5 off the wall, straight out from the lamp. Along: the eye 0.5 off the wall, 5 tiles before it.
  const faceOn = (x: number, m = WOOD) => peak(x, 5, 1.5, m);
  const along = (x: number, m = WOOD) => peak(x, 0, 0.5, m);
  // Along, the eye's ray mirrored through the wall from (0, −0.5) to the lamp crosses y = 0 here.
  const mirrorX = 5 / 3;

  test('seen face-on, glossy wood shows a soft spot where it mirrors the lamp', () => {
    expect(faceOn(5)).toBeGreaterThan(0.3);
    expect(faceOn(4.25)).toBeLessThan(faceOn(5) / 4);
    expect(faceOn(5.75)).toBeLessThan(faceOn(5) / 4);
  });

  test('seen along the wall, the same reflection stretches into a streak towards the lamp', () => {
    // Two tiles on from the mirror point it keeps most of its strength; face-on, 0.75 off the spot loses most.
    expect(along(mirrorX + 2)).toBeGreaterThan(along(mirrorX) * 0.8);
  });

  test('fades out past the lamp', () => {
    expect(along(6)).toBeLessThan(along(mirrorX) / 20);
  });

  test('rough brick barely shines face-on, but streaks along the wall', () => {
    expect(faceOn(5, BRICK)).toBeLessThan(along(mirrorX + 2, BRICK) / 5);
    expect(along(mirrorX + 2, BRICK)).toBeGreaterThan(0.4);
  });

  test('is zero for a lamp behind the wall or out of reach', () => {
    expect(peak(mirrorX, 0, 0.5, WOOD, { ...l, y: -1 })).toBe(0);
    expect(peak(mirrorX, 0, 0.5, WOOD, { ...l, radius: 1 })).toBe(0);
  });
});

describe('bounceHeight', () => {
  const l = { ...lamp(5, 1), radius: 4.5 };
  const at = (x: number) => bounceHeight(l, x, 0, 0, 0.5);

  test('is the mirror height at the mirror point, climbing towards the lamp’s height beyond it', () => {
    expect(at(5 / 3)).toBeCloseTo(0.5 + (0.85 - 0.5) / 3, 5);
    expect(at(3.5)).toBeGreaterThan(at(5 / 3));
    expect(at(3.5)).toBeLessThan(0.85);
  });
});

describe('bakeLighting reflection lamps', () => {
  /** The first wallLamp slot of a cell's face (0 W, 1 E, 2 N, 3 S), at sample column u. */
  const slot = (lm: ReturnType<typeof bakeLighting>, cx: number, cy: number, face: number, u = 0) =>
    ((lm.faceOffset[(cy * lm.map.width + cx) * 4 + face] as number) / WALL_V + u) * REFLECTION_LAMPS;

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
    // light's reach (4) but not its reflection's (6).
    const at = slot(lm, 1, 3, 2);
    expect([...lm.wallLamp.subarray(at, at + REFLECTION_LAMPS)]).toEqual([1, 0, -1]);
  });

  test('a lamp hidden behind the pillar is never listed', () => {
    // The lamp sits in the east half's top row; the top wall's face over x = 1 faces it, but the pillar is between.
    const lm = bakeLighting(map, [lamp(4.5, 1.5)], 0.45, GREY, GREY);
    const behind = slot(lm, 1, 0, 3);
    expect([...lm.wallLamp.subarray(behind, behind + WALL_U * REFLECTION_LAMPS)]).toEqual(
      new Array(WALL_U * REFLECTION_LAMPS).fill(-1)
    );
  });
});

describe('brightestReflection', () => {
  const corridor = parseMap(`
1111111111
1S.......1
1........1
1111111111
`);

  test('picks the lamp you look towards along the wall, not the one beside you', () => {
    // Close to the top wall at x = 2.5, under the near lamp, looking east to the far one.
    const lm = bakeLighting(corridor, [lamp(2.5, 2.5), lamp(7.5, 2.5)], 0.45, GREY, GREY);
    const at = ((lm.faceOffset[(0 * corridor.width + 5) * 4 + 3] as number) / WALL_V) * REFLECTION_LAMPS;
    const peak = new Float64Array(1);
    expect(brightestReflection(lm, at, 16, 0.4, 0, 1, 5, 1, 2.5, 1.3, peak)).toBe(1);
    expect(peak[0] as number).toBeGreaterThan(0);
  });
});

describe('reflection on the floor', () => {
  // The floor faces up. The eye at (0, 0) looks along +x at a lamp 5 tiles off.
  const l = { ...lamp(5, 0), radius: 4.5 };
  const at = (x: number, y = 0) => reflection(l, 16, 0.1, 0, 0, 1, x, y, 0, 0, 0);

  test('smears from near the eye towards the lamp, strongest part way, gone under it', () => {
    expect(at(3)).toBeGreaterThan(0.5);
    expect(at(1)).toBeLessThan(at(3) / 2);
    expect(at(5)).toBeLessThan(0.05);
  });

  test('is narrow across the view', () => {
    expect(at(2.5, 0.5)).toBeLessThan(at(2.5) / 10);
  });

  test('is zero out of reach', () => {
    expect(reflection({ ...l, radius: 1 }, 16, 0.1, 0, 0, 1, 3, 0, 0, 0, 0)).toBe(0);
  });
});

describe('bakeLighting floor lamps', () => {
  /** The first floorLamp slot of the floor at (x, y). */
  const slot = (lm: ReturnType<typeof bakeLighting>, x: number, y: number) =>
    (Math.floor(y * FLOOR_SUB) * lm.map.width * FLOOR_SUB + Math.floor(x * FLOOR_SUB)) * REFLECTION_LAMPS;

  test('lists the lamps a floor spot can see, nearest first', () => {
    const lm = bakeLighting(map, [lamp(5.5, 2.5), lamp(1.5, 2.5)], 0.45, GREY, GREY);
    const at = slot(lm, 1.6, 2.4);
    expect([...lm.floorLamp.subarray(at, at + REFLECTION_LAMPS)]).toEqual([1, 0, -1]);
  });

  test('a lamp hidden behind the pillar is never listed', () => {
    // The pillar at (3, 1) stands between (1.5, 1.5) and a lamp at (5.5, 1.5).
    const lm = bakeLighting(map, [lamp(5.5, 1.5)], 0.45, GREY, GREY);
    const at = slot(lm, 1.5, 1.5);
    expect([...lm.floorLamp.subarray(at, at + REFLECTION_LAMPS)]).toEqual([-1, -1, -1]);
  });
});

describe('bakeLighting wall runs', () => {
  /** The run (start, end along its axis) of a cell's face (0 W, 1 E, 2 N, 3 S). */
  const run = (lm: ReturnType<typeof bakeLighting>, cx: number, cy: number, face: number) => {
    const index = (lm.faceOffset[(cy * lm.map.width + cx) * 4 + face] as number) / (WALL_U * WALL_V);
    return [lm.faceRun[index * 2], lm.faceRun[index * 2 + 1]];
  };
  const lm = bakeLighting(map, [], 0.45, GREY, GREY);

  test('a long wall’s faces share one run, end to end', () => {
    // The bottom wall's top (north) faces, x = 1 to 5.
    expect(run(lm, 2, 3, 2)).toEqual([1, 6]);
    expect(run(lm, 5, 3, 2)).toEqual([1, 6]);
  });

  test('a run stops where the wall stops having floor in front', () => {
    // The top wall's bottom (south) faces are cut at x = 3, where the pillar stands against it.
    expect(run(lm, 1, 0, 3)).toEqual([1, 3]);
    expect(run(lm, 4, 0, 3)).toEqual([4, 6]);
  });

  test('a pillar face is a run of one', () => {
    expect(run(lm, 3, 1, 3)).toEqual([3, 4]);
  });
});

describe('bounce light', () => {
  // Room A (x 1–5) with a short-reach lamp in its west corner; room B (x 7–9) sealed off by the wall at x = 6.
  const rooms = parseMap(`
11111111111
1S....1...1
1.....1...1
11111111111
`);
  const near = { ...lamp(1.5, 1.5), radius: 2 };
  const BLUE = rgb(20, 20, 200);
  const bake = (wall = GREY) => bakeLighting(rooms, [near], 0.1, GREY, GREY, { wallColours: [0, wall], strength: 1 });
  const flat = bakeLighting(rooms, [near], 0.1, GREY, GREY);
  const floorAt = (lm: ReturnType<typeof bakeLighting>, x: number, y: number) =>
    lm.floor[Math.floor(y * FLOOR_SUB) * lm.stride + Math.floor(x * FLOOR_SUB)] as number;
  const channels = (c: number) => [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff] as const;
  const out = new Float64Array(3);
  const ambient = (lm: ReturnType<typeof bakeLighting>, x: number, y: number) => {
    ambientAt(lm, x, y, out);
    return [...out];
  };

  test('light bounces into the room’s far end, out of the lamp’s reach', () => {
    const [r] = channels(floorAt(bake(), 5.5, 2.5));
    const [r0] = channels(floorAt(flat, 5.5, 2.5));
    expect(r).toBeGreaterThan(r0);
  });

  test('it fades with distance from the lit part', () => {
    const lm = bake();
    expect(ambient(lm, 2.5, 1.5)[0] as number).toBeGreaterThan(ambient(lm, 5.5, 2.5)[0] as number);
  });

  test('no light gets through a wall: the sealed room keeps the bare ambient', () => {
    expect(ambient(bake(), 8.5, 1.5)).toEqual([0.1, 0.1, 0.1]);
    expect(floorAt(bake(), 8.5, 1.5)).toBe(floorAt(flat, 8.5, 1.5));
  });

  test('walls tint what they throw back: blue walls make the bounce blue', () => {
    // The bounce part, over the bare ambient.
    const [r, , b] = ambient(bake(BLUE), 4.5, 2.5).map((v) => v - 0.1) as [number, number, number];
    expect(b).toBeGreaterThan(r * 1.5);
  });

  test('without bounce, ambient is flat', () => {
    expect(ambient(flat, 5.5, 2.5)).toEqual([0.1, 0.1, 0.1]);
  });
});
