import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { rgb } from './framebuffer';
import {
  ambientAt,
  bakeLighting,
  bounceHeight,
  DIR_BACK,
  DIR_FRONT,
  DIR_TOP,
  directLight,
  distanceToWall,
  FLOOR_NORMAL,
  FLOOR_SUB,
  type Light,
  REFLECTION_LAMPS,
  REFLECTION_PATH,
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
/** A wall's south face, facing +y. */
const FACING_SOUTH = { dx: 0, dy: 1, dz: 0 };

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
      most = Math.max(most, reflection(light, m, FACING_SOUTH, x, 0, z, { x: ex, y: ey }));
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
    expect(along(mirrorX + 2)).toBeGreaterThan(along(mirrorX) * 0.6);
  });

  test('fades out past the lamp', () => {
    expect(along(6)).toBeLessThan(along(mirrorX) / 20);
  });

  test('rough brick barely shines face-on, but streaks along the wall', () => {
    expect(faceOn(5, BRICK)).toBeLessThan(along(mirrorX + 2, BRICK) / 5);
    expect(along(mirrorX + 2, BRICK)).toBeGreaterThan(0.4);
  });

  test('is zero for a lamp behind the wall', () => {
    expect(peak(mirrorX, 0, 0.5, WOOD, { ...l, y: -1 })).toBe(0);
  });

  test('a lamp past its light’s reach still reflects: it fades with the whole path, eye to wall to lamp', () => {
    // A corridor lamp (reach 4.5) 12 tiles down the wall: it lights nothing near the eye, but you still see it mirrored.
    const far = { ...lamp(12, 1), radius: 4.5 };
    expect(peak(4, 0, 0.5, WOOD, far)).toBeGreaterThan(0.05);
    // Farther lamps fade, and past REFLECTION_PATH they're gone.
    expect(peak(4, 0, 0.5, WOOD, { ...far, x: 16 })).toBeLessThan(peak(4, 0, 0.5, WOOD, far));
    expect(peak(4, 0, 0.5, WOOD, { ...far, x: REFLECTION_PATH + 1 })).toBe(0);
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
    const short = (x: number, y: number) => ({ ...lamp(x, y), radius: 1 });
    const lm = bakeLighting(map, [short(1.5, 1.5), short(5.5, 1.5)], 0.45, GREY, GREY);
    expect(lm.wallLamp.every((i) => i >= -1 && i < 2)).toBe(true);
    expect(lm.wallLamp.some((i) => i === 0)).toBe(true);
    expect(lm.wallLamp.some((i) => i === 1)).toBe(true);
  });

  test('lists the nearest lamp in sight in each direction (east, west, south, north), past its light’s reach too', () => {
    const lm = bakeLighting(map, [lamp(5.5, 2.5), lamp(1.5, 2.5)], 0.45, GREY, GREY);
    // The bottom wall's top (north) face at x ≈ 1: lamp 0 lies east, 4 tiles off, out of its light's reach (4) but in
    // sight; lamp 1 lies just north.
    const at = slot(lm, 1, 3, 2);
    // Two per direction, east, west, south, north: lamp 0 east, lamp 1 north.
    expect([...lm.wallLamp.subarray(at, at + REFLECTION_LAMPS)]).toEqual([0, -1, -1, -1, -1, -1, 1, -1]);
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

describe('reflection on the floor', () => {
  // The floor faces up. The eye at (0, 0) looks along +x at a lamp 5 tiles off.
  const l = { ...lamp(5, 0), radius: 4.5 };
  const FLOOR = { shininess: 16, f0: 0.1 };
  const EYE = { x: 0, y: 0 };
  const at = (x: number, y = 0) => reflection(l, FLOOR, FLOOR_NORMAL, x, y, 0, EYE);

  test('smears from near the eye towards the lamp, strongest part way, gone under it', () => {
    expect(at(3)).toBeGreaterThan(0.5);
    expect(at(1)).toBeLessThan(at(3));
    expect(at(5)).toBeLessThan(0.05);
  });

  test('is narrow across the view', () => {
    expect(at(2.5, 0.5)).toBeLessThan(at(2.5) / 10);
  });

  test('is zero once the path, eye to floor to lamp, is past REFLECTION_PATH', () => {
    expect(reflection({ ...l, x: REFLECTION_PATH + 1 }, FLOOR, FLOOR_NORMAL, 3, 0, 0, EYE)).toBe(0);
  });
});

describe('bakeLighting floor lamps', () => {
  /** The first floorLamp slot of the floor at (x, y). */
  const slot = (lm: ReturnType<typeof bakeLighting>, x: number, y: number) =>
    (Math.floor(y * FLOOR_SUB) * lm.map.width * FLOOR_SUB + Math.floor(x * FLOOR_SUB)) * REFLECTION_LAMPS;

  test('lists the nearest lamp a floor spot can see in each direction (east, west, south, north)', () => {
    const lm = bakeLighting(map, [lamp(5.5, 2.5), lamp(1.5, 2.5)], 0.45, GREY, GREY);
    // From (1.6, 2.4): lamp 0 lies east, lamp 1 just west.
    const at = slot(lm, 1.6, 2.4);
    expect([...lm.floorLamp.subarray(at, at + REFLECTION_LAMPS)]).toEqual([0, -1, 1, -1, -1, -1, -1, -1]);
  });

  test('lamps in a row down a corridor: the nearer one doesn’t push out the one behind it', () => {
    // From (2.5, 2.5), lamps at x = 5.5 and 10.5 both lie east; the farther one's reflection can show past the nearer.
    const hall = parseMap(`
111111111111
1S.........1
1..........1
111111111111
`);
    const lm = bakeLighting(hall, [lamp(10.5, 2), lamp(5.5, 2)], 0.45, GREY, GREY);
    const at = slot(lm, 2.5, 2.5);
    expect([...lm.floorLamp.subarray(at, at + 2)]).toEqual([1, 0]);
  });

  test('a nearer lamp behind never pushes out a farther one ahead', () => {
    // From (2.5, 2.5): two lamps close by to the west and one each to the south and north, all nearer than lamp 0 far
    // to the east. It still keeps the east slot.
    const hall = parseMap(`
111111111111
1S.........1
1..........1
1..........1
1..........1
111111111111
`);
    const lm = bakeLighting(
      hall,
      [lamp(10.5, 2.5), lamp(1.5, 2.5), lamp(1.5, 3.5), lamp(2.5, 1.5), lamp(2.5, 4.5)],
      0.45,
      GREY,
      GREY
    );
    const at = slot(lm, 2.5, 2.5);
    expect(lm.floorLamp[at]).toBe(0);
  });

  test('a lamp hidden behind the pillar is never listed', () => {
    // The pillar at (3, 1) stands between (1.5, 1.5) and a lamp at (5.5, 1.5).
    const lm = bakeLighting(map, [lamp(5.5, 1.5)], 0.45, GREY, GREY);
    const at = slot(lm, 1.5, 1.5);
    expect([...lm.floorLamp.subarray(at, at + REFLECTION_LAMPS)]).toEqual(new Array(REFLECTION_LAMPS).fill(-1));
  });
});

describe('distanceToWall', () => {
  // Wall cells x = 1–3 on row 1 face south into a hall, their faces on y = 2; open floor beyond their east end.
  const hall = parseMap(`
11111111
1111...1
1S.....1
11111111
`);
  const lm = bakeLighting(hall, [], 0.45, GREY, GREY);
  const SOUTH = { dx: 0, dy: 1, dz: 0 };
  // The face of the wall cell (2, 1), facing south.
  const base = lm.faceOffset[(1 * hall.width + 2) * 4 + 3] as number;

  test('alongside the wall it is how far the eye stands off its face', () => {
    expect(distanceToWall(lm, base, SOUTH, 2.5, 2, { x: 3.5, y: 2.75 })).toBeCloseTo(0.75);
  });

  test('past the end of the wall, it counts to that end, not to the wall’s endless plane', () => {
    // The run ends at x = 4: an eye at (6, 2.5) is 0.5 off the plane but 2 tiles along from the end.
    expect(distanceToWall(lm, base, SOUTH, 2.5, 2, { x: 6, y: 2.5 })).toBeCloseTo(Math.hypot(0.5, 2));
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

describe('far lamps in the lists', () => {
  // A long hall: a short-reach lamp at its east end, the floor and walls at its west end far out of its light.
  const hall = parseMap(`
1111111111111111
1S.............1
1..............1
1111111111111111
`);
  const lm = bakeLighting(hall, [{ ...lamp(14.5, 1.5), radius: 2 }], 0.45, GREY, GREY);

  test('the floor lists a lamp it can see past its light’s reach', () => {
    const at = (Math.floor(2 * FLOOR_SUB) * lm.stride + Math.floor(3 * FLOOR_SUB)) * REFLECTION_LAMPS;
    expect(lm.floorLamp[at]).toBe(0);
  });

  test('so do the walls', () => {
    // The top wall's south face over x = 3.
    const face = lm.faceOffset[(0 * hall.width + 3) * 4 + 3] as number;
    expect(lm.wallLamp[(face / WALL_V) * REFLECTION_LAMPS]).toBe(0);
  });
});

test('a map with more lamps than the lamp lists can number is refused', () => {
  const many = Array.from({ length: 128 }, () => lamp(1.5, 1.5));
  expect(() => bakeLighting(map, many, 0.45, GREY, GREY)).toThrow(/128 lamps/);
});

test('lamps past LAMP_SIGHT (16 tiles) are not listed, even in plain sight', () => {
  const long = parseMap(`
1111111111111111111111
1S...................1
1111111111111111111111
`);
  const lm = bakeLighting(long, [lamp(20.5, 1.5)], 0.45, GREY, GREY);
  const cell = (x: number) => (Math.floor(1.5 * FLOOR_SUB) * lm.stride + Math.floor(x * FLOOR_SUB)) * REFLECTION_LAMPS;
  // 15.5 tiles off: listed; 19.5 off: not.
  expect(lm.floorLamp[cell(5)]).toBe(0);
  expect([...lm.floorLamp.subarray(cell(1), cell(1) + REFLECTION_LAMPS)]).toEqual(new Array(REFLECTION_LAMPS).fill(-1));
});

describe('soft shadows', () => {
  // A room with a pillar at (4, 3); a lamp east of it throws its shadow west, across the floor and onto the west wall.
  const room = parseMap(`
1111111111
1S.......1
1........1
1...1....1
1........1
1........1
1111111111
`);
  const lm = bakeLighting(room, [{ x: 6.5, y: 3.5, z: 0.85, radius: 7, r: 4, g: 4, b: 4 }], 0.1, GREY, GREY);
  /** The largest step between neighbours, as a share of the whole range from darkest to brightest. */
  const steepest = (values: number[]) => {
    const range = Math.max(...values) - Math.min(...values);
    let step = 0;
    for (let i = 1; i < values.length; i++) {
      step = Math.max(step, Math.abs((values.at(i) as number) - (values.at(i - 1) as number)));
    }
    expect(range).toBeGreaterThan(20);
    return step / range;
  };

  test('the floor fades into the shadow over several cells instead of stepping', () => {
    // Down x = 2.5 across the shadow's north edge, cell by cell.
    const red: number[] = [];
    for (let y = 1.25 * FLOOR_SUB; y < 3 * FLOOR_SUB; y++) {
      red.push((lm.floor[y * lm.stride + Math.floor(2.5 * FLOOR_SUB)] as number) & 0xff);
    }
    expect(steepest(red)).toBeLessThan(0.4);
  });

  test('so does the wall', () => {
    // Along the west wall's east face (tile x = 0), mid-height, across the shadow's north edge.
    const light: number[] = [];
    const levels = RELIEF_LEVELS.length;
    for (let ty = 1; ty <= 3; ty++) {
      const base = lm.faceOffset[(ty * room.width + 0) * 4 + 1] as number;
      for (let u = 0; u < WALL_U; u++) {
        light.push((lm.wall[(base + u * WALL_V + WALL_V / 2) * levels] as number) & 0xff);
      }
    }
    expect(steepest(light)).toBeLessThan(0.4);
  });

  test('a lamp’s reflection fades with it: the floor lists how much of the lamp each cell sees', () => {
    const seen = new Set<number>();
    for (let y = 1.25 * FLOOR_SUB; y < 3 * FLOOR_SUB; y++) {
      const at = (y * lm.stride + Math.floor(2.5 * FLOOR_SUB)) * REFLECTION_LAMPS;
      for (let k = 0; k < REFLECTION_LAMPS; k++) {
        if (lm.floorLamp[at + k] === 0) {
          seen.add(lm.floorLampSeen[at + k] as number);
        }
      }
    }
    expect(seen.has(255)).toBe(true);
    expect([...seen].some((s) => s > 0 && s < 255)).toBe(true);
  });

  test('the walls list it too', () => {
    const seen = new Set<number>();
    for (let ty = 1; ty <= 3; ty++) {
      const base = lm.faceOffset[(ty * room.width + 0) * 4 + 1] as number;
      for (let u = 0; u < WALL_U; u++) {
        const at = (base / WALL_V + u) * REFLECTION_LAMPS;
        for (let k = 0; k < REFLECTION_LAMPS; k++) {
          if (lm.wallLamp[at + k] === 0) {
            seen.add(lm.wallLampSeen[at + k] as number);
          }
        }
      }
    }
    expect([...seen].some((s) => s > 0 && s < 255)).toBe(true);
  });
});
