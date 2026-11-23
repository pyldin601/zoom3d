import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createLightWave, type LightChanges } from './light-wave';
import { bakeLighting, FLOOR_SUB, LAMP, type Light, type Lighting } from './lighting';
import { CEILING, FLOOR } from './walls';

/** A corridor 30 tiles long, 3 wide. */
const MAP = parseMap(
  ['1'.repeat(32), ...Array.from({ length: 3 }, () => `1${'.'.repeat(30)}1`), '1'.repeat(32)]
    .join('\n')
    .replace('.', 'S')
);
const lamp = (x: number, y: number): Light => ({ x, y, z: 0.85, radius: 4.5, ...LAMP });
const bake = (lights: Light[]) => bakeLighting(MAP, lights, 0.2, FLOOR, CEILING);
const DARK = bakeLighting(MAP, [], 0, FLOOR, CEILING);
const C = 6;

/** Changes newest first, as the timeline holds them. */
const changes = (...list: [number, Lighting][]): LightChanges => ({
  count: list.length,
  timeAt: (back) => list.at(back)?.[0] ?? 0,
  lightingAt: (back) => list.at(back)?.[1] ?? null,
});

/** The floor cell at (x, y). */
const cellAt = (lm: Lighting, x: number, y: number) =>
  Math.floor(y * FLOOR_SUB) * lm.stride + Math.floor(x * FLOOR_SUB);
const centre = (lm: Lighting, at: number) => ({
  x: ((at % lm.stride) + 0.5) / FLOOR_SUB,
  y: (Math.floor(at / lm.stride) + 0.5) / FLOOR_SUB,
});
/** The light path a lamp's change takes to the eye through a floor cell: lamp → cell → eye. */
const pathTiles = (l: Light, p: { x: number; y: number }, eye: { x: number; y: number }) =>
  Math.hypot(Math.hypot(l.x - p.x, l.y - p.y), l.z) + Math.hypot(p.x - eye.x, p.y - eye.y);
const channelSum = (c: number) => (c & 0xff) + ((c >>> 8) & 0xff) + ((c >>> 16) & 0xff);
const within1 = (a: number, b: number) =>
  [0, 8, 16].every((shift) => Math.abs(((a >>> shift) & 0xff) - ((b >>> shift) & 0xff)) <= 1);

describe('the lights-out wave (D41)', () => {
  test('with every lamp lit all along, the wave is the table itself, to a byte', () => {
    const lit = bake([lamp(5.5, 2.5), lamp(12.5, 2.5)]);
    const wave = createLightWave().update(changes([0, lit]), { x: 20, y: 2.5 }, 100_000, C);
    expect(lit.floor.every((c, i) => within1(c, wave.floor[i] as number))).toBe(true);
    expect(lit.ceiling.every((c, i) => within1(c, wave.ceiling[i] as number))).toBe(true);
    expect(lit.wall.every((c, i) => within1(c, wave.wall[i] as number))).toBe(true);
    expect(wave.lights).toBe(lit.lights);
  });

  test('a place lit by one lamp goes dark when the switch has gone lamp → place → eye, and not before', () => {
    const l = lamp(5.5, 2.5);
    const lit = bake([l]);
    const eye = { x: 20.5, y: 2.5 };
    const at = cellAt(lit, 8.5, 2.5);
    const arrives = 10_000 + (pathTiles(l, centre(lit, at), eye) / C) * 1000;
    const before = createLightWave().update(changes([10_000, DARK], [0, lit]), eye, arrives - 60, C);
    expect(within1(before.floor[at] as number, lit.floor[at] as number)).toBe(true);
    const after = createLightWave().update(changes([10_000, DARK], [0, lit]), eye, arrives + 60, C);
    expect(after.floor[at]).toBe(DARK.floor[at]);
  });

  test('lit by two lamps it dims in two steps, the nearer lamp first', () => {
    const near = lamp(10.5, 2.5);
    const far = lamp(5.5, 2.5);
    const lit = bake([far, near]);
    const eye = { x: 28.5, y: 2.5 };
    const at = cellAt(lit, 8.5, 2.5);
    const p = centre(lit, at);
    const nearGoes = 10_000 + (pathTiles(near, p, eye) / C) * 1000;
    const farGoes = 10_000 + (pathTiles(far, p, eye) / C) * 1000;
    expect(nearGoes).toBeLessThan(farGoes);
    const wave = createLightWave();
    const history = changes([10_000, DARK], [0, lit]);
    const brightness = (now: number) => channelSum(wave.update(history, eye, now, C).floor[at] as number);
    const before = brightness(nearGoes - 20);
    const between = brightness((nearGoes + farGoes) / 2);
    const after = brightness(farGoes + 20);
    expect(before).toBeGreaterThan(between);
    expect(between).toBeGreaterThan(after);
  });

  test('switching on, light grows out of the lamp the same way', () => {
    const l = lamp(5.5, 2.5);
    const lit = bake([l]);
    const eye = { x: 20.5, y: 2.5 };
    const at = cellAt(lit, 8.5, 2.5);
    const arrives = 10_000 + (pathTiles(l, centre(lit, at), eye) / C) * 1000;
    const wave = createLightWave();
    const history = changes([10_000, lit], [0, DARK]);
    expect(wave.update(history, eye, arrives - 60, C).floor[at]).toBe(DARK.floor[at]);
    expect(within1(wave.update(history, eye, arrives + 60, C).floor[at] as number, lit.floor[at] as number)).toBe(true);
  });

  test('two changes close together: near places show the newest, then the dark, then the oldest', () => {
    const l = lamp(5.5, 2.5);
    const lit = bake([l]);
    const eye = { x: 5.5, y: 2.5 };
    const now = 10_900;
    const wave = createLightWave().update(changes([10_300, lit], [10_000, DARK], [0, lit]), eye, now, C);
    // The newest change's light has gone 3.6 tiles, the dark's 5.4.
    let checked = 0;
    for (let at = 0; at < lit.floor.length; at++) {
      const p = centre(lit, at);
      const flat = Math.hypot(p.x - l.x, p.y - l.y);
      if (MAP.tiles[Math.floor(p.y) * MAP.width + Math.floor(p.x)] !== 0 || flat >= l.radius) {
        continue;
      }
      const tiles = pathTiles(l, p, eye);
      if (Math.abs(tiles - 3.6) < 0.2 || Math.abs(tiles - 5.4) < 0.2) {
        continue;
      }
      const expected = tiles < 3.6 || tiles > 5.4 ? lit : DARK;
      expect(within1(wave.floor[at] as number, expected.floor[at] as number)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  test('a thing at a point sees a lamp lit by the same rule', () => {
    const l = lamp(5.5, 2.5);
    const lit = bake([l]);
    const eye = { x: 20.5, y: 2.5 };
    const thing = { x: 7.5, y: 2.5 };
    const arrives = 10_000 + ((Math.hypot(2, 0) + Math.hypot(13, 0)) / C) * 1000;
    const wave = createLightWave();
    const history = changes([10_000, DARK], [0, lit]);
    expect(wave.update(history, eye, arrives - 30, C).wave?.lampLit(0, thing.x, thing.y)).toBe(true);
    expect(wave.update(history, eye, arrives + 30, C).wave?.lampLit(0, thing.x, thing.y)).toBe(false);
  });

  test('a lamp’s reflection goes out with the place', () => {
    const l = lamp(5.5, 2.5);
    const lit = bake([l]);
    const eye = { x: 6.5, y: 2.5 };
    const at = cellAt(lit, 6.5, 2.5);
    const history = changes([10_000, DARK], [0, lit]);
    const wave = createLightWave();
    const listed = (lm: Lighting) => lm.floorLamp.slice(at * 8, at * 8 + 8).filter((i) => i >= 0).length;
    expect(listed(wave.update(history, eye, 10_001, C))).toBeGreaterThan(0);
    expect(listed(wave.update(history, eye, 20_000, C))).toBe(0);
  });
});
