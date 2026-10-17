import { type PlayerState, parseMap } from '@zoom3d/shared';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { createView, setView } from '../camera';
import { type RoomScene, renderView } from '../frame';
import { createFramebuffer, type Framebuffer, rgb } from '../framebuffer';
import { bakeLighting, DIR_BACK, DIR_FRONT, DIR_LEFT, DIR_RIGHT, DIR_TOP } from '../lighting';
import { renderSprites } from '../sprites';
import { makeTextures } from '../textures';
import { buildModel, glowing, renderVoxel, type VoxelInstance, type VoxelLight } from '../voxels';
import { lampLight, type SurfacePoint } from './bake';
import type { TracedLighting } from './frame';
import { createLightmaps, planeLight } from './lightmaps';
import { tracedObjectLight } from './objects';
import { bakeRoom } from './test-helpers';
import { shownPixel } from './tone';
import { buildTracedWorld } from './world';

const TEXTURES = makeTextures(1);
const WIDTH = 19;
const HEIGHT = 9;
/** An open room 17 × 7 tiles with one lamp, at (3.5, 4.5). */
const ROOM = parseMap(
  [
    '1'.repeat(WIDTH),
    `1S${'.'.repeat(WIDTH - 3)}1`,
    ...Array.from({ length: HEIGHT - 3 }, () => `1${'.'.repeat(WIDTH - 2)}1`),
    '1'.repeat(WIDTH),
  ].join('\n')
);
const LAMP = { x: 3.5, y: 4.5 };
const BELOW_LAMP = { x: 3.5, y: 4.5 };
const SIX_TILES_FROM_LAMP = { x: 9.5, y: 4.5 };

const MID_GREY_BYTE = 124;
const MID_GREY = 0.2;
const CHANNELS = 3;
const DIRECTIONS = [DIR_TOP, DIR_FRONT, DIR_BACK, DIR_RIGHT, DIR_LEFT] as const;
const SIDES = [DIR_FRONT, DIR_BACK, DIR_RIGHT, DIR_LEFT] as const;

const CUBE = buildModel({ x: 1, y: 1, z: 1 }, 0.2, () => rgb(100, 100, 100));
const vacuumAt = (at: { x: number; y: number }, angle = 0): VoxelInstance => ({ model: CUBE, ...at, angle });

/** One direction's multiplier for one channel (0 red, 1 green, 2 blue). */
function multiplier(light: Float64Array, direction: number, channel: number): number {
  const value = light.at(direction * CHANNELS + channel);
  if (value === undefined) {
    throw new Error(`no multiplier for direction ${direction}, channel ${channel}`);
  }
  return value;
}

function lightOf(light: VoxelLight, v: VoxelInstance): Float64Array {
  const out = new Float64Array(DIRECTIONS.length * CHANNELS);
  light(v, out);
  return out;
}

/** The byte the traced room shows for a grey of this linear radiance. */
function shownGreyByte(radiance: number): number {
  return shownPixel(radiance, radiance, radiance) & 0xff;
}

function channelOf(vector: Float32Array, channel: number): number {
  const value = vector.at(channel);
  if (value === undefined) {
    throw new Error(`no channel ${channel}`);
  }
  return value;
}

describe('tracedObjectLight in a room with a lamp', () => {
  let traced: TracedLighting;
  let light: VoxelLight;

  beforeAll(() => {
    traced = bakeRoom(ROOM, TEXTURES, [LAMP]);
    light = tracedObjectLight(traced);
  });

  test('a vacuum under the lamp has a larger top multiplier than one 6 tiles from it', () => {
    const under = lightOf(light, vacuumAt(BELOW_LAMP));
    const away = lightOf(light, vacuumAt(SIX_TILES_FROM_LAMP));
    for (let channel = 0; channel < CHANNELS; channel++) {
      expect(multiplier(under, DIR_TOP, channel)).toBeGreaterThan(multiplier(away, DIR_TOP, channel));
    }
  });

  test('under the lamp the top multiplier exceeds every side, which the lamp shines nowhere on', () => {
    const under = lightOf(light, vacuumAt(BELOW_LAMP));
    for (const side of SIDES) {
      for (let channel = 0; channel < CHANNELS; channel++) {
        expect(multiplier(under, DIR_TOP, channel)).toBeGreaterThan(multiplier(under, side, channel));
      }
    }
  });

  test('a face is as bright as a mid grey the traced room lights: shown(0.2 x light) over the sRGB of 0.2', () => {
    const v = vacuumAt({ x: 5.2, y: 3.9 }, 0.7);
    const bounce = new Float32Array(CHANNELS);
    planeLight(traced.maps.floorBounce, traced.world, v.x, v.y, bounce);
    const lamps = new Float32Array(CHANNELS);
    const cos = Math.cos(v.angle);
    const sin = Math.sin(v.angle);
    // Each direction's normal on the map: the model's front is (cos, sin) and its right (-sin, cos).
    const normals = [
      [DIR_TOP, 0, 0, 1],
      [DIR_FRONT, cos, sin, 0],
      [DIR_BACK, -cos, -sin, 0],
      [DIR_RIGHT, -sin, cos, 0],
      [DIR_LEFT, sin, -cos, 0],
    ] as const;
    const result = lightOf(light, v);
    for (const [direction, nx, ny, nz] of normals) {
      const at: SurfacePoint = { x: v.x, y: v.y, z: CUBE.height / 2, nx, ny, nz };
      lampLight(traced.world, at, lamps);
      for (let channel = 0; channel < CHANNELS; channel++) {
        const irradiance = channelOf(lamps, channel) + channelOf(bounce, channel);
        const expected = shownGreyByte(MID_GREY * irradiance) / MID_GREY_BYTE;
        expect(multiplier(result, direction, channel)).toBeCloseTo(expected, 6);
      }
    }
  });

  test('the face turned to the lamp is the brightest side, and turning the vacuum turns the light with it', () => {
    // The lamp is 2 tiles ahead of a vacuum facing +x, and at its back, left and right when it faces the other ways.
    const beside = { x: LAMP.x - 2, y: LAMP.y };
    const sideTowardLamp = (angle: number) => {
      const result = lightOf(light, vacuumAt(beside, angle));
      return SIDES.reduce((best, side) => (multiplier(result, side, 0) > multiplier(result, best, 0) ? side : best));
    };
    expect(sideTowardLamp(0)).toBe(DIR_FRONT);
    expect(sideTowardLamp(Math.PI)).toBe(DIR_BACK);
    // Facing +y, the model's right is -x and its left +x, where the lamp is.
    expect(sideTowardLamp(Math.PI / 2)).toBe(DIR_LEFT);
    expect(sideTowardLamp(-Math.PI / 2)).toBe(DIR_RIGHT);
  });

  test('repeated calls, and calls for other vacuums in between, give the same answer', () => {
    const first = lightOf(light, vacuumAt(BELOW_LAMP, 0.3));
    lightOf(light, vacuumAt(SIX_TILES_FROM_LAMP, 2));
    expect(lightOf(light, vacuumAt(BELOW_LAMP, 0.3))).toEqual(first);
  });

  test('a light made for the same lighting answers like this one', () => {
    const v = vacuumAt({ x: 6.1, y: 2.4 }, 1.1);
    expect(lightOf(tracedObjectLight(traced), v)).toEqual(lightOf(light, v));
  });

  test('every multiplier is a finite number, never negative', () => {
    for (const at of [BELOW_LAMP, SIX_TILES_FROM_LAMP, { x: 1.2, y: 1.2 }, { x: 17.7, y: 7.6 }]) {
      for (const value of lightOf(light, vacuumAt(at, 0.4))) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('tracedObjectLight with no lamps', () => {
  const world = buildTracedWorld(ROOM, TEXTURES, []);
  const v = vacuumAt({ x: 6.5, y: 3.5 });

  test('a room with no light at all leaves every face dark', () => {
    const dark = lightOf(tracedObjectLight({ world, maps: createLightmaps(world) }), v);
    expect([...dark].every((value) => value === 0)).toBe(true);
  });

  test("the floor's bounce light alone lights every face the same", () => {
    const maps = createLightmaps(world);
    maps.floorBounce.fill(0.5);
    const lit = lightOf(tracedObjectLight({ world, maps }), v);
    const expected = shownGreyByte(MID_GREY * 0.5) / MID_GREY_BYTE;
    expect(expected).toBeGreaterThan(0);
    for (const direction of DIRECTIONS) {
      for (let channel = 0; channel < CHANNELS; channel++) {
        expect(multiplier(lit, direction, channel)).toBeCloseTo(expected, 6);
      }
    }
  });

  test('bounce light too bright for the screen still gives a finite, larger multiplier', () => {
    const maps = createLightmaps(world);
    maps.floorBounce.fill(1e6);
    const lit = lightOf(tracedObjectLight({ world, maps }), v);
    expect(multiplier(lit, DIR_TOP, 0)).toBeCloseTo(255 / MID_GREY_BYTE, 6);
  });
});

describe('renderVoxel with an object light', () => {
  const player: PlayerState = { x: 1.5, y: 4.5, angle: 0 };
  const view = setView(createView(), createFramebuffer(), player);
  const box = vacuumAt({ x: 3.5, y: 4.5 }, Math.PI);

  function blank(): Framebuffer {
    const fb = createFramebuffer();
    fb.zbuffer.fill(Number.POSITIVE_INFINITY);
    return fb;
  }

  const drawn = (fb: Framebuffer) => new Set([...fb.pixels].filter((pixel) => pixel !== 0));

  /** Fills every direction's r, g, b with `share`. */
  const evenLight =
    (share: number): VoxelLight =>
    (_, out) => {
      out.fill(share);
    };

  test("its multipliers colour each face's unshaded colour", () => {
    const fb = blank();
    renderVoxel(fb, view, box, null, evenLight(0.5));
    expect(drawn(fb)).toEqual(new Set([rgb(50, 50, 50)]));
  });

  test('it brightens past the colour itself, up to white', () => {
    const fb = blank();
    renderVoxel(fb, view, box, null, evenLight(1.5));
    expect(drawn(fb)).toEqual(new Set([rgb(150, 150, 150)]));
    const blown = blank();
    renderVoxel(blown, view, box, null, evenLight(9));
    expect(drawn(blown)).toEqual(new Set([rgb(255, 255, 255)]));
  });

  test('it is asked once, for the instance drawn, with room for 5 directions of r, g, b', () => {
    const ask = vi.fn<VoxelLight>((_, out) => out.fill(1));
    renderVoxel(blank(), view, box, null, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    const [instance, out] = ask.mock.calls.at(0) ?? [];
    expect(instance).toBe(box);
    expect(out).toBeInstanceOf(Float64Array);
    expect(out?.length).toBe(DIRECTIONS.length * CHANNELS);
  });

  test('it wins over the lighting when both are given', () => {
    const grey = rgb(100, 100, 100);
    const lighting = bakeLighting(ROOM, [], 0.45, grey, grey);
    const lit = blank();
    renderVoxel(lit, view, box, lighting);
    expect(drawn(lit).has(rgb(45, 45, 45))).toBe(true);
    const both = blank();
    renderVoxel(both, view, box, lighting, evenLight(0.5));
    expect(drawn(both)).toEqual(new Set([rgb(50, 50, 50)]));
  });

  test('a fully glowing voxel shows its own colour whatever the object light', () => {
    const own = rgb(200, 10, 10);
    const model = buildModel({ x: 1, y: 1, z: 1 }, 0.2, () => glowing(own, 1));
    for (const share of [0, 0.5, 3]) {
      const fb = blank();
      renderVoxel(fb, view, { ...box, model }, null, evenLight(share));
      expect(drawn(fb)).toEqual(new Set([own]));
    }
  });

  test('renderSprites hands the scene’s object light to the voxels', () => {
    const fb = blank();
    renderSprites(fb, { eye: player, people: [], objects: [box], lighting: null, objectLight: evenLight(0.5) });
    expect(drawn(fb)).toEqual(new Set([rgb(50, 50, 50)]));
  });

  test('renderSprites draws unlit without one, as it always has', () => {
    const fb = blank();
    renderSprites(fb, { eye: player, people: [], objects: [box], lighting: null });
    const colours = drawn(fb);
    expect(colours.has(rgb(100, 100, 100))).toBe(true);
    expect(colours.has(rgb(50, 50, 50))).toBe(false);
  });
});

describe('a vacuum drawn in the traced room', () => {
  let traced: TracedLighting;
  const eye: PlayerState = { x: 12.5, y: 4.5, angle: Math.PI };

  beforeAll(() => {
    traced = bakeRoom(ROOM, TEXTURES, [LAMP]);
  });

  /** The brightest red channel among the pixels the vacuum at `at` paints. */
  function brightestRed(at: { x: number; y: number }): number {
    const fb = createFramebuffer();
    fb.zbuffer.fill(Number.POSITIVE_INFINITY);
    renderSprites(fb, {
      eye,
      people: [],
      objects: [vacuumAt(at)],
      lighting: null,
      objectLight: tracedObjectLight(traced),
    });
    return fb.pixels.reduce((brightest, pixel) => Math.max(brightest, pixel & 0xff), 0);
  }

  test('is brighter under the lamp than 6 tiles from it', () => {
    expect(brightestRed(BELOW_LAMP)).toBeGreaterThan(brightestRed(SIX_TILES_FROM_LAMP));
  });
});

describe('renderView lights objects from the traced room', () => {
  let traced: TracedLighting;
  const fb = createFramebuffer(160, 90);

  beforeAll(() => {
    traced = bakeRoom(ROOM, TEXTURES, [LAMP]);
  });

  function sceneOf(tracedLighting: TracedLighting | null): RoomScene {
    return {
      map: ROOM,
      textures: TEXTURES,
      eye: { x: 12.5, y: 4.5, angle: Math.PI },
      lighting: null,
      reflections: 'none',
      traced: tracedLighting,
      people: [],
      objects: [vacuumAt(BELOW_LAMP)],
      labels: [],
      ownGlow: null,
      firstPerson: null,
    };
  }

  test('a traced scene gets an object light', () => {
    const scene = sceneOf(traced);
    renderView(fb, scene);
    expect(scene.objectLight).toBeTypeOf('function');
  });

  test('the same TracedLighting keeps its object light from frame to frame, across scenes', () => {
    const scene = sceneOf(traced);
    renderView(fb, scene);
    const first = scene.objectLight;
    renderView(fb, scene);
    expect(scene.objectLight).toBe(first);
    const another = sceneOf(traced);
    renderView(fb, another);
    expect(another.objectLight).toBe(first);
  });

  test('a new TracedLighting gets a new object light', () => {
    const scene = sceneOf(traced);
    renderView(fb, scene);
    const first = scene.objectLight;
    scene.traced = { world: traced.world, maps: traced.maps };
    renderView(fb, scene);
    expect(scene.objectLight).toBeTypeOf('function');
    expect(scene.objectLight).not.toBe(first);
  });

  test('a scene that is not traced has none, even after a traced frame', () => {
    const scene = sceneOf(traced);
    renderView(fb, scene);
    scene.traced = null;
    renderView(fb, scene);
    expect(scene.objectLight ?? null).toBeNull();
  });
});
