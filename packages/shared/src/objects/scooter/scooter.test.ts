import { describe, expect, test } from 'vitest';
import { LEVEL1 } from '../../map/level1';
import { parseMap, tileAt } from '../../map/map';
import { canMount, rackSpots, restoreScooters, SCOOTER_COUNT, saveScooters } from './scooter';

const MAP = parseMap(LEVEL1);

describe('rackSpots', () => {
  test('puts every scooter on a floor tile, never on the spawn', () => {
    const spots = rackSpots(MAP);
    expect(spots).toHaveLength(SCOOTER_COUNT);
    for (const s of spots) {
      expect(tileAt(MAP, Math.floor(s.x), Math.floor(s.y))).toBe(0);
      expect(Math.floor(s.x) === MAP.spawn.x && Math.floor(s.y) === MAP.spawn.y).toBe(false);
    }
  });

  test('stand side by side against the south wall of the hall south of the spawn room, one a cell, handlebars north', () => {
    expect(SCOOTER_COUNT).toBe(6);
    expect(rackSpots(MAP)).toEqual(
      [32.5, 33.5, 34.5, 35.5, 36.5, 37.5].map((x) => ({ x, y: 55.5, angle: -Math.PI / 2 }))
    );
    for (const s of rackSpots(MAP)) {
      expect(tileAt(MAP, Math.floor(s.x), Math.floor(s.y) + 1)).not.toBe(0);
    }
  });

  test('drops spots that are walls on another map', () => {
    expect(rackSpots(parseMap('111\n1S1\n111'))).toEqual([]);
  });
});

describe('canMount', () => {
  test('reaches one tile, plus any slack', () => {
    expect(canMount({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(true);
    expect(canMount({ x: 0, y: 0 }, { x: 1.01, y: 0 })).toBe(false);
    expect(canMount({ x: 0, y: 0 }, { x: 1.4, y: 0 }, 0.5)).toBe(true);
  });
});

describe('save and restore', () => {
  test('round-trips parked scooters', () => {
    const scooters = [{ id: 'a', x: 38.5, y: 50.5, angle: 1 }];
    expect(restoreScooters(MAP, saveScooters(MAP, scooters))).toEqual(scooters);
  });

  test('refuses a save for another map', () => {
    expect(restoreScooters(MAP, { map: 'other', scooters: [{ id: 'a', x: 38.5, y: 50.5, angle: 1 }] })).toBeNull();
  });

  test('refuses a save with a scooter inside a wall', () => {
    const save = saveScooters(MAP, [{ id: 'a', x: 0.5, y: 0.5, angle: 0 }]);
    expect(restoreScooters(MAP, save)).toBeNull();
  });

  test('refuses a malformed save', () => {
    expect(restoreScooters(MAP, { map: saveScooters(MAP, []).map, scooters: [{ id: 3 }] })).toBeNull();
    expect(restoreScooters(MAP, null)).toBeNull();
  });
});
