import { describe, expect, test } from 'vitest';
import { LEVEL1 } from './level1';
import { isWallAt, parseMap, spawnPoint, tileAt, validateMap } from './map';

const ROOM = '111\n1S1\n111';

describe('parseMap', () => {
  test('parses dimensions, tiles and spawn', () => {
    const map = parseMap(ROOM);
    expect(map.width).toBe(3);
    expect(map.height).toBe(3);
    expect(map.spawn).toEqual({ x: 1, y: 1 });
    expect(map.tiles[4]).toBe(0);
    expect(map.tiles[0]).toBe(1);
  });

  test('trims surrounding blank lines', () => {
    expect(parseMap(`\n${ROOM}\n`).height).toBe(3);
  });

  test('rejects non-rectangular input naming the row', () => {
    expect(() => parseMap('11S\n111\n11')).toThrow(/row 3/);
  });

  test('rejects unknown characters', () => {
    expect(() => parseMap('1x1\n1S1')).toThrow(/row 1/);
  });

  test('rejects zero or multiple spawns', () => {
    expect(() => parseMap('111\n1.1')).toThrow(/spawn/);
    expect(() => parseMap('1S1\n1S1')).toThrow(/spawn/);
  });
});

describe('tile queries', () => {
  const map = parseMap(ROOM);

  test('out of bounds is stone wall', () => {
    expect(tileAt(map, -1, 0)).toBe(1);
    expect(tileAt(map, 3, 1)).toBe(1);
  });

  test('isWallAt floors continuous coordinates', () => {
    expect(isWallAt(map, 1.9, 1.2)).toBe(false);
    expect(isWallAt(map, 2.0, 1.2)).toBe(true);
    expect(isWallAt(map, 0.99, 1.5)).toBe(true);
  });
});

describe('validateMap', () => {
  test('accepts a closed room', () => {
    expect(validateMap(parseMap(ROOM))).toEqual([]);
  });

  test('reports a non-wall border tile', () => {
    expect(validateMap(parseMap('1.1\n1S1\n111'))).toEqual([expect.stringMatching(/border/)]);
  });

  test('reports floor unreachable from spawn', () => {
    const errors = validateMap(parseMap('11111\n1S1.1\n11111'));
    expect(errors).toEqual([expect.stringMatching(/\(3, 1\).*unreachable/)]);
  });

  test('LEVEL1 is a valid 63x57 level with spawn at (29, 50)', () => {
    const map = parseMap(LEVEL1);
    expect([map.width, map.height]).toEqual([63, 57]);
    expect(map.spawn).toEqual({ x: 29, y: 50 });
    expect(validateMap(map)).toEqual([]);
  });
});

describe('spawnPoint', () => {
  const map = parseMap(LEVEL1);
  for (const [name, rng] of [
    ['low', () => 0],
    ['high', () => 0.999],
  ] as const) {
    test(`${name} rng gives an open floor tile centre near S`, () => {
      const p = spawnPoint(map, rng);
      expect(isWallAt(map, p.x, p.y)).toBe(false);
      expect(p.x % 1).toBe(0.5);
      expect(p.y % 1).toBe(0.5);
      expect(Math.hypot(p.x - (map.spawn.x + 0.5), p.y - (map.spawn.y + 0.5))).toBeLessThanOrEqual(2);
      expect([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]).toContain(p.angle);
      expect(isWallAt(map, p.x + Math.round(Math.cos(p.angle)), p.y + Math.round(Math.sin(p.angle)))).toBe(false);
    });
  }
});
