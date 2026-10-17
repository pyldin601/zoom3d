import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { corridorLights } from '../lighting';
import { makeTextures } from '../textures';
import type { TracedLighting } from './frame';
import type { TracedLightmaps } from './lightmaps';
import { createTracedRoom, type TracedRoom } from './room';

/** A 3 x 7 corridor: long enough for corridorLights to hang lamps in it. */
const CORRIDOR = `
11111
1S..1
1...1
1...1
1...1
1...1
1...1
1...1
11111`;

const MAP = parseMap(CORRIDOR);
const TEXTURES = makeTextures(1);
/** A budget of nothing still runs one slice, so each call to `bake` with it is exactly one. */
const ONE_SLICE = 0;
const NO_END = Number.POSITIVE_INFINITY;
/** Far more slices than the corridor's bake has, so a bake that never finishes fails the test instead of hanging it. */
const MOST_SLICES = 10_000;
const MAP_NAMES = [
  'floor',
  'ceiling',
  'wall',
  'floorSoft',
  'ceilingSoft',
  'floorBounce',
] as const satisfies readonly (keyof TracedLightmaps)[];

function newRoom(lit = true): TracedRoom {
  return createTracedRoom(MAP, TEXTURES, lit);
}

function lightingOf(room: TracedRoom): TracedLighting {
  const lighting = room.lighting();
  if (!lighting) {
    throw new Error('the bake has not finished');
  }
  return lighting;
}

/** Bakes `slices` slices of `room` (fewer if it finishes first); the slices that ran. */
function bakeSlices(room: TracedRoom, slices: number, budgetMs = ONE_SLICE): number {
  let ran = 0;
  while (ran < slices && room.lighting() === null) {
    room.bake(budgetMs);
    ran++;
  }
  return ran;
}

function bakeToTheEnd(room: TracedRoom, budgetMs = ONE_SLICE): number {
  const ran = bakeSlices(room, MOST_SLICES, budgetMs);
  expect(room.lighting()).not.toBeNull();
  return ran;
}

function expectSameMaps(actual: TracedLighting, expected: TracedLighting): void {
  for (const name of MAP_NAMES) {
    expect(actual.maps[name], name).toEqual(expected.maps[name]);
  }
}

describe('the corridor the tests bake', () => {
  test('has lamps to light it', () => {
    expect(corridorLights(MAP).length).toBeGreaterThan(0);
  });
});

describe('createTracedRoom', () => {
  test('has no lighting before any bake', () => {
    expect(newRoom().lighting()).toBeNull();
  });

  test('is still unlit after a first slice, and lit once the bake is done', () => {
    const room = newRoom();
    room.bake(ONE_SLICE);
    expect(room.lighting()).toBeNull();
    bakeToTheEnd(room);
    expect(lightingOf(room).world.map).toBe(MAP);
  });

  test('bakes the corridor lamps into the maps', () => {
    const room = newRoom();
    room.bake(NO_END);
    const { floor } = lightingOf(room).maps;
    expect(Math.max(...floor)).toBeGreaterThan(0);
  });

  test('short bakes, one after another, end with the maps of one long bake', () => {
    const sliced = newRoom();
    bakeToTheEnd(sliced, 1);
    const whole = newRoom();
    whole.bake(NO_END);
    expectSameMaps(lightingOf(sliced), lightingOf(whole));
  });

  test('a bake of no time still moves on, a slice a call', () => {
    const room = newRoom();
    expect(bakeSlices(room, 3)).toBe(3);
    expect(room.lighting()).toBeNull();
  });

  test('a pause between slices resumes the bake: it needs the slices of one without a pause, not more', () => {
    const uninterrupted = newRoom();
    const slicesNeeded = bakeToTheEnd(uninterrupted);
    const paused = newRoom();
    const slicesBeforeThePause = bakeSlices(paused, 3);
    expect(paused.lighting()).toBeNull();
    const slicesAfterThePause = bakeToTheEnd(paused);
    expect(slicesBeforeThePause + slicesAfterThePause).toBe(slicesNeeded);
    expectSameMaps(lightingOf(paused), lightingOf(uninterrupted));
  });

  test('keeps the finished lighting: another bake leaves it as it is', () => {
    const room = newRoom();
    room.bake(NO_END);
    const lighting = lightingOf(room);
    room.bake(NO_END);
    expect(room.lighting()).toBe(lighting);
  });

  test('unlit (lit: false) never bakes', () => {
    const room = newRoom(false);
    room.bake(NO_END);
    expect(room.lighting()).toBeNull();
  });
});
