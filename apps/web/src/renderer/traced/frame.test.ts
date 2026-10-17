import {
  castRay,
  createRayHit,
  FOV_TALL,
  fovForAspect,
  type GameMap,
  LEVEL1,
  type PlayerState,
  parseMap,
} from '@zoom3d/shared';
import { beforeAll, describe, expect, test } from 'vitest';
import { createView, EYE_HEIGHT, setView } from '../camera';
import { createFramebuffer, type Framebuffer, rgb } from '../framebuffer';
import { corridorLights } from '../lighting';
import { makeTextures, TEX } from '../textures';
import { renderWalls } from '../walls';
import { bakeLighting } from './bake';
import { lastTracedBuffers, renderTraced, type TracedLighting } from './frame';
import { createLightmaps, planeLight, WALL_HEIGHTS, wallColumnLight } from './lightmaps';
import { fresnel } from './optics';
import { shownPixel } from './tone';
import { buildTracedWorld, FACE_WEST, TRACED_MATERIALS, type TracedMaterial } from './world';

const LEVEL = parseMap(LEVEL1);
const TEXTURES = makeTextures(1);
const STONE = 1;
const WOOD = 2;

/** Eye poses on LEVEL1: the corridor x 33..35, y 21..43 has lamps at (34.5, 36.5) and (34.5, 31.5). */
const LAMP_LOOKOUT: PlayerState = { x: 34.5, y: 40, angle: -Math.PI / 2 };
const WOOD_ROOM: PlayerState = { x: 34.5, y: 3.5, angle: -Math.PI / 2 };
const SPAWN_EAST: PlayerState = { x: 29.5, y: 50.5, angle: 0 };
const SPAWN_SOUTH: PlayerState = { x: 29.5, y: 50.5, angle: Math.PI / 2 };
const POSES: readonly (readonly [string, PlayerState])[] = [
  ['at spawn, angle exactly 0', SPAWN_EAST],
  ['at spawn, angle exactly π/2', SPAWN_SOUTH],
  ['at spawn, angle exactly π', { x: 29.5, y: 50.5, angle: Math.PI }],
  ['0.26 tiles from a wall, facing it', { x: 28.26, y: 50.5, angle: Math.PI }],
  ['0.26 tiles from a wall, facing along it', { x: 28.26, y: 50.5, angle: -Math.PI / 2 }],
  ['0.26 tiles from a wall, facing it aslant', { x: 28.26, y: 50.5, angle: Math.PI + 0.4 }],
  ['on a tile corner', { x: 34, y: 40, angle: 0.3 }],
  ['in the corridor between two lamps', LAMP_LOOKOUT],
  ['in the wood room', WOOD_ROOM],
];

function materialOf(tile: number): TracedMaterial {
  const material = TRACED_MATERIALS.at(tile);
  if (!material) {
    throw new Error(`no material for tile ${tile}`);
  }
  return material;
}

function bakeRoom(
  map: GameMap,
  textures: readonly Uint32Array[],
  lamps: readonly { x: number; y: number }[]
): TracedLighting {
  const world = buildTracedWorld(map, textures, lamps);
  const maps = createLightmaps(world);
  for (const _ of bakeLighting(world, maps)) {
    // Run to the end.
  }
  return { world, maps };
}

function draw(fb: Framebuffer, eye: PlayerState, traced: TracedLighting): void {
  renderTraced(fb, { map: traced.world.map, eye, people: [], traced });
}

/** The pixel that shows the point (x, y) at height z (0 floor .. 1 ceiling) from `eye`. */
function pixelOf(fb: Framebuffer, eye: PlayerState, x: number, y: number, z: number): { col: number; row: number } {
  const view = setView(createView(), fb, eye);
  const offsetX = x - eye.x;
  const offsetY = y - eye.y;
  const across = view.invDet * (view.dirY * offsetX - view.dirX * offsetY);
  const depth = view.invDet * (-view.planeY * offsetX + view.planeX * offsetY);
  return {
    col: Math.floor(view.halfWidth * (1 + across / depth)),
    row: Math.floor(view.half - ((z - EYE_HEIGHT) * view.proj) / depth),
  };
}

function pixelAt(fb: Framebuffer, col: number, row: number): number {
  return fb.pixels.at(row * fb.width + col) ?? 0;
}

function brightness(pixel: number): number {
  return (pixel & 0xff) + ((pixel >>> 8) & 0xff) + ((pixel >>> 16) & 0xff);
}

function opaqueEverywhere(fb: Framebuffer): boolean {
  return fb.pixels.findIndex((pixel) => pixel >>> 24 !== 0xff) === -1;
}

describe('renderTraced on LEVEL1', () => {
  let traced: TracedLighting;
  const fb = createFramebuffer();

  beforeAll(() => {
    traced = bakeRoom(LEVEL, TEXTURES, corridorLights(LEVEL));
  });

  test.each(POSES)("the z-buffer is the current renderer's, %s", (_, eye) => {
    const reference = createFramebuffer();
    renderWalls(reference, { map: LEVEL, eye, textures: TEXTURES, lighting: null });
    draw(fb, eye, traced);
    expect(Array.from(fb.zbuffer)).toEqual(Array.from(reference.zbuffer));
  });

  describe('lamps', () => {
    const lamp = { x: 34.5, y: 36.5 };

    test('a ceiling pixel inside a lamp disc is warm white: red full, then green, then blue', () => {
      draw(fb, LAMP_LOOKOUT, traced);
      const { col, row } = pixelOf(fb, LAMP_LOOKOUT, lamp.x, lamp.y, 1);
      const pixel = pixelAt(fb, col, row);
      const [red, green, blue] = [pixel & 0xff, (pixel >>> 8) & 0xff, (pixel >>> 16) & 0xff];
      expect(red).toBe(255);
      expect(green).toBeLessThanOrEqual(red);
      expect(blue).toBeLessThanOrEqual(green);
      expect(blue).toBeGreaterThan(0);
      const [lampRed = 0, lampGreen = 0, lampBlue = 0] = traced.world.lampRgb;
      expect(pixel).toBe(shownPixel(lampRed, lampGreen, lampBlue));
    });

    test('the disc ends: the ceiling 0.4 tiles from its centre is much darker', () => {
      draw(fb, LAMP_LOOKOUT, traced);
      const inside = pixelOf(fb, LAMP_LOOKOUT, lamp.x, lamp.y, 1);
      const beside = pixelOf(fb, LAMP_LOOKOUT, lamp.x + 0.4, lamp.y, 1);
      expect(brightness(pixelAt(fb, beside.col, beside.row))).toBeLessThan(
        brightness(pixelAt(fb, inside.col, inside.row)) / 3
      );
    });

    test('the floor under a lamp is brighter than the floor 4 tiles further down the corridor', () => {
      draw(fb, LAMP_LOOKOUT, traced);
      const under = pixelOf(fb, LAMP_LOOKOUT, lamp.x, lamp.y, 0);
      const further = pixelOf(fb, LAMP_LOOKOUT, lamp.x, lamp.y - 4, 0);
      expect(under.row).toBeLessThan(fb.height);
      expect(further.row).toBeGreaterThan(fb.height / 2);
      expect(brightness(pixelAt(fb, under.col, under.row))).toBeGreaterThan(
        brightness(pixelAt(fb, further.col, further.row))
      );
    });
  });

  test.each([
    ['floor', 300, 100],
    ['floor', 330, 500],
    ['ceiling', 20, 80],
    ['ceiling', 60, 590],
  ] as const)(
    'a %s pixel (row %i, column %i) is the bilinear light at its point times the surface colour',
    (surface, row, col) => {
      draw(fb, LAMP_LOOKOUT, traced);
      const { hdr, view, rowDistance, wallStart, wallEnd } = lastTracedBuffers();
      expect(surface === 'floor' ? row >= (wallEnd.at(col) ?? 0) : row < (wallStart.at(col) ?? 0)).toBe(true);
      const cameraX = (2 * col) / fb.width - 1;
      const distance = rowDistance.at(row) ?? 0;
      const light = new Float32Array(3);
      const [map, albedo] =
        surface === 'floor'
          ? [traced.maps.floor, traced.world.floorAlbedo]
          : [traced.maps.ceiling, traced.world.ceilingAlbedo];
      planeLight(
        map,
        traced.world,
        view.x + distance * (view.dirX + view.planeX * cameraX),
        view.y + distance * (view.dirY + view.planeY * cameraX),
        light
      );
      let lit = 0;
      for (let channel = 0; channel < 3; channel++) {
        const expected = (light.at(channel) ?? 0) * (albedo.at(channel) ?? 0);
        lit += expected;
        expect(hdr.at((row * fb.width + col) * 3 + channel) ?? 0).toBeCloseTo(expected, 5);
      }
      expect(lit).toBeGreaterThan(0);
    }
  );

  describe('the Fresnel weight kept for the reflections', () => {
    test('a floor pixel near the bottom of the frame has a lower weight than one just below the wall', () => {
      draw(fb, LAMP_LOOKOUT, traced);
      const { spec, wallEnd } = lastTracedBuffers();
      const col = fb.width / 2;
      const justBelow = spec.at((wallEnd.at(col) ?? 0) * fb.width + col) ?? 0;
      const bottom = spec.at((fb.height - 1) * fb.width + col) ?? 0;
      expect(bottom).toBeGreaterThan(0);
      expect(bottom).toBeLessThan(justBelow);
    });

    test("the floor weight is the floor material's at the slant the pixel is seen at", () => {
      draw(fb, LAMP_LOOKOUT, traced);
      const col = fb.width / 2;
      const row = fb.height - 1;
      const slope = (row + 0.5 - fb.height / 2) / (fb.width / 2 / Math.tan(fb.fov / 2));
      const planeLength = Math.tan(fb.fov / 2);
      const cameraX = (2 * col) / fb.width - 1;
      const cos = slope / Math.sqrt(1 + (cameraX * planeLength) ** 2 + slope * slope);
      const expected = fresnel(cos, materialOf(0));
      expect(lastTracedBuffers().spec.at(row * fb.width + col)).toBeCloseTo(expected, 6);
      expect(lastTracedBuffers().specTile.at(row * fb.width + col)).toBe(0);
    });

    test('the mortar between bricks reflects nothing, and the bricks do', () => {
      const stoneWall: PlayerState = { x: 22.5, y: 4.5, angle: -Math.PI / 2 };
      draw(fb, stoneWall, traced);
      const col = fb.width / 2;
      expect(castRay(LEVEL, stoneWall.x, stoneWall.y, 0, -1, createRayHit()).tile).toBe(STONE);
      const { spec, specTile, wallStart, wallEnd } = lastTracedBuffers();
      const rows = Array.from(
        { length: (wallEnd.at(col) ?? 0) - (wallStart.at(col) ?? 0) },
        (_, at) => (wallStart.at(col) ?? 0) + at
      );
      expect(rows.length).toBeGreaterThan(100);
      expect(rows.some((row) => spec.at(row * fb.width + col) === 0)).toBe(true);
      expect(rows.some((row) => (spec.at(row * fb.width + col) ?? 0) > 0)).toBe(true);
      expect(rows.every((row) => specTile.at(row * fb.width + col) === STONE)).toBe(true);
    });

    test('the ceiling reflects nothing', () => {
      draw(fb, LAMP_LOOKOUT, traced);
      const { spec, wallStart } = lastTracedBuffers();
      let ceilingPixels = 0;
      for (let col = 0; col < fb.width; col++) {
        for (let row = 0; row < (wallStart.at(col) ?? 0); row++) {
          ceilingPixels++;
          expect(spec.at(row * fb.width + col)).toBe(0);
        }
      }
      expect(ceilingPixels).toBeGreaterThan(fb.pixels.length / 10);
    });

    test("a wood wall pixel has the wood material's weight at its slant, and the tile id to tint with", () => {
      draw(fb, WOOD_ROOM, traced);
      const col = fb.width / 2;
      const row = 120;
      const hit = castRay(LEVEL, WOOD_ROOM.x, WOOD_ROOM.y, 0, -1, createRayHit());
      expect(hit.tile).toBe(WOOD);
      const rise = (fb.height / 2 - (row + 0.5)) / (fb.width / 2 / Math.tan(fb.fov / 2));
      const expected = fresnel(1 / Math.sqrt(1 + rise * rise), materialOf(WOOD));
      const buffers = lastTracedBuffers();
      expect(buffers.spec.at(row * fb.width + col)).toBeCloseTo(expected, 6);
      expect(buffers.specTile.at(row * fb.width + col)).toBe(WOOD);
    });
  });

  describe('every pixel is written', () => {
    function expectComplete(frame: Framebuffer): void {
      expect(opaqueEverywhere(frame)).toBe(true);
      expect(lastTracedBuffers().hdr.every(Number.isFinite)).toBe(true);
      expect(frame.zbuffer.every((distance) => distance > 0)).toBe(true);
    }

    test.each(POSES)('at 640×360, %s', (_, eye) => {
      fb.pixels.fill(0);
      draw(fb, eye, traced);
      expectComplete(fb);
    });

    test.each(POSES)('at 296×640 with FOV_TALL, %s', (_, eye) => {
      const portrait = createFramebuffer(296, 640, FOV_TALL);
      draw(portrait, eye, traced);
      expectComplete(portrait);
    });

    test('in a frame whose height is odd, which puts a row on the horizon', () => {
      const odd = createFramebuffer(301, 361, fovForAspect(301 / 361));
      for (const [, eye] of POSES) {
        odd.pixels.fill(0);
        draw(odd, eye, traced);
        expectComplete(odd);
      }
    });

    test('after the same framebuffer switches from 640×360 to 296×640', () => {
      const switching = createFramebuffer();
      draw(switching, SPAWN_EAST, traced);
      Object.assign(switching, createFramebuffer(296, 640, FOV_TALL));
      draw(switching, SPAWN_SOUTH, traced);
      expect([switching.width, switching.height]).toEqual([296, 640]);
      expectComplete(switching);
    });
  });

  describe('the buffers', () => {
    test('are reused from frame to frame, and replaced when the size or the field of view changes', () => {
      draw(fb, LAMP_LOOKOUT, traced);
      const first = lastTracedBuffers();
      draw(fb, WOOD_ROOM, traced);
      expect(lastTracedBuffers().hdr).toBe(first.hdr);
      expect(lastTracedBuffers().spec).toBe(first.spec);

      const portrait = createFramebuffer(296, 640, FOV_TALL);
      draw(portrait, WOOD_ROOM, traced);
      expect(lastTracedBuffers().hdr).not.toBe(first.hdr);
      expect(lastTracedBuffers().hdr.length).toBe(296 * 640 * 3);

      const widerSameSize = createFramebuffer(296, 640, FOV_TALL + 0.1);
      const portraitBuffers = lastTracedBuffers();
      draw(widerSameSize, WOOD_ROOM, traced);
      expect(lastTracedBuffers().floorFresnel).not.toBe(portraitBuffers.floorFresnel);
    });
  });

  test('a pixel that reflects nothing is its light through the tone curve, as shownPixel gives it', () => {
    draw(fb, LAMP_LOOKOUT, traced);
    const { hdr, spec } = lastTracedBuffers();
    let checked = 0;
    for (let at = 0; at < fb.pixels.length; at++) {
      if ((spec.at(at) ?? 0) !== 0) {
        continue;
      }
      checked++;
      const expected = shownPixel(hdr.at(at * 3) ?? 0, hdr.at(at * 3 + 1) ?? 0, hdr.at(at * 3 + 2) ?? 0);
      if (fb.pixels.at(at) !== expected) {
        expect(fb.pixels.at(at), `pixel ${at}`).toBe(expected);
      }
    }
    expect(checked).toBeGreaterThan(fb.pixels.length / 10);
  });
});

/** An 11 × 11 room, walled all round, the eye in its middle. */
const ROOM = parseMap(
  [
    '11111111111',
    ...Array.from({ length: 9 }, (_, row) => (row === 4 ? '1....S....1' : '1.........1')),
    '11111111111',
  ].join('\n')
);
const MIDDLE = { x: 5.5, y: 5.5 };

function linearOfByte(byte: number): number {
  const encoded = byte / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function byteOfLinear(linear: number): number {
  return Math.round((linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055) * 255);
}

function lightAt(pixel: number): number {
  const { hdr } = lastTracedBuffers();
  return (hdr.at(pixel * 3) ?? 0) + (hdr.at(pixel * 3 + 1) ?? 0) + (hdr.at(pixel * 3 + 2) ?? 0);
}

describe('the walls take the baked light of their own face', () => {
  const GREY_BYTE = 128;
  /** Every texel the same, so the light is the only thing that varies over a wall. */
  const GREY_TEXTURES = Array.from({ length: 4 }, () =>
    new Uint32Array(TEX * TEX).fill(rgb(GREY_BYTE, GREY_BYTE, GREY_BYTE))
  );
  const fb = createFramebuffer();
  const eyeLevelRow = fb.height / 2 - 1;

  /** The frame column whose ray meets the wall nearest `along` (x on a north or south wall, y on a west or east one). */
  function columnAimedAt(eye: PlayerState, axis: 'x' | 'y', along: number): number {
    const view = setView(createView(), fb, eye);
    let nearest = 0;
    let nearestError = Number.POSITIVE_INFINITY;
    for (let col = 0; col < fb.width; col++) {
      const cameraX = (2 * col) / fb.width - 1;
      const rayX = view.dirX + view.planeX * cameraX;
      const rayY = view.dirY + view.planeY * cameraX;
      const { distance } = castRay(ROOM, eye.x, eye.y, rayX, rayY, createRayHit());
      const error = Math.abs((axis === 'x' ? eye.x + distance * rayX : eye.y + distance * rayY) - along);
      if (error < nearestError) {
        nearest = col;
        nearestError = error;
      }
    }
    return nearest;
  }

  // The camera plane is to the right of facing, so facing +x the right of the frame is +y (south).
  test.each([
    ['east', 0, { x: 8.5, y: 3 }, 'left'],
    ['south', Math.PI / 2, { x: 3, y: 8.5 }, 'right'],
    ['west', Math.PI, { x: 2.5, y: 3 }, 'right'],
    ['north', -Math.PI / 2, { x: 8, y: 2.5 }, 'right'],
  ] as const)('the %s wall is brighter, over the frame, on the side nearer a lamp: the %s', (_, angle, lamp, side) => {
    const room = bakeRoom(ROOM, GREY_TEXTURES, [lamp]);
    draw(fb, { ...MIDDLE, angle }, room);
    const third = Math.floor(fb.width / 3);
    const lightOver = (from: number, to: number) => {
      let total = 0;
      for (let col = from; col < to; col++) {
        total += lightAt(eyeLevelRow * fb.width + col);
      }
      return total;
    };
    const left = lightOver(0, third);
    const right = lightOver(fb.width - third, fb.width);
    const [nearer, farther] = side === 'left' ? [left, right] : [right, left];
    expect(nearer).toBeGreaterThan(farther * 2);
  });

  // A face is one tile wide, so its 8 columns of light are laid out in the direction wallX runs: along +x on a north or
  // south face and +y on a west or east one. A lamp at one end of a tile, 1 tile out from the wall, lights that end.
  test.each([
    ['east', 0, 'y', { x: 9, y: 3 }, 3.1, 3.9],
    ['south', Math.PI / 2, 'x', { x: 4, y: 9 }, 3.9, 3.1],
    ['west', Math.PI, 'y', { x: 2, y: 4 }, 3.9, 3.1],
    ['north', -Math.PI / 2, 'x', { x: 3, y: 2 }, 3.1, 3.9],
  ] as const)(
    'on the %s wall, within one tile, the end nearer the lamp is brighter',
    (_, angle, axis, lamp, near, far) => {
      const room = bakeRoom(ROOM, GREY_TEXTURES, [lamp]);
      const eye = { ...MIDDLE, angle };
      draw(fb, eye, room);
      const nearLight = lightAt(eyeLevelRow * fb.width + columnAimedAt(eye, axis, near));
      const farLight = lightAt(eyeLevelRow * fb.width + columnAimedAt(eye, axis, far));
      expect(nearLight).toBeGreaterThan(farLight * 1.3);
    }
  );

  test('at eye level a wall pixel is its texture times the middle row of its column of baked light', () => {
    const room = bakeRoom(ROOM, GREY_TEXTURES, [{ x: 8.5, y: 4 }]);
    const eye = { ...MIDDLE, angle: 0 };
    draw(fb, eye, room);
    const hit = castRay(ROOM, eye.x, eye.y, 1, 0, createRayHit());
    const faceIndex = room.world.faceIndex.at((hit.mapY * room.world.width + hit.mapX) * 4 + FACE_WEST) ?? -1;
    const light = new Float32Array(WALL_HEIGHTS * 3);
    wallColumnLight(room.maps, faceIndex, hit.wallX, light);
    const { hdr } = lastTracedBuffers();
    const at = (eyeLevelRow * fb.width + fb.width / 2) * 3;
    for (let channel = 0; channel < 3; channel++) {
      const middle = light.at(3 + channel) ?? 0;
      expect(middle).toBeGreaterThan(0);
      // Within 5%: the pixel is a hair above eye level, where the light has begun to change towards the ceiling's.
      expect((hdr.at(at + channel) ?? 0) / (linearOfByte(GREY_BYTE) * middle)).toBeCloseTo(1, 1);
    }
  });

  test('the top of a wall takes the light of its ceiling row and the bottom that of its floor row', () => {
    // A lamp is a disc facing down, so it lights the wall at its own height not at all: the rows differ.
    const room = bakeRoom(ROOM, GREY_TEXTURES, [{ x: 8.5, y: 5.5 }]);
    const eye = { ...MIDDLE, angle: 0 };
    draw(fb, eye, room);
    const col = fb.width / 2;
    const hit = castRay(ROOM, eye.x, eye.y, 1, 0, createRayHit());
    const faceIndex = room.world.faceIndex.at((hit.mapY * room.world.width + hit.mapX) * 4 + FACE_WEST) ?? -1;
    const light = new Float32Array(WALL_HEIGHTS * 3);
    wallColumnLight(room.maps, faceIndex, hit.wallX, light);
    const brightest = Math.max(...light);
    const { wallStart, wallEnd, hdr } = lastTracedBuffers();
    const bottom = ((wallEnd.at(col) ?? 0) - 1) * fb.width + col;
    const top = (wallStart.at(col) ?? 0) * fb.width + col;
    for (let channel = 0; channel < 3; channel++) {
      const floorRow = light.at(channel) ?? 0;
      const ceilingRow = light.at((WALL_HEIGHTS - 1) * 3 + channel) ?? 0;
      expect(floorRow - ceilingRow).toBeGreaterThan(brightest / 10);
      const tolerance = 0.05 * linearOfByte(GREY_BYTE) * brightest;
      expect(Math.abs((hdr.at(bottom * 3 + channel) ?? 0) - linearOfByte(GREY_BYTE) * floorRow)).toBeLessThan(
        tolerance
      );
      expect(Math.abs((hdr.at(top * 3 + channel) ?? 0) - linearOfByte(GREY_BYTE) * ceilingRow)).toBeLessThan(tolerance);
    }
  });
});

describe('the walls show the same texels as the current renderer', () => {
  /** Red climbs across the texture and blue down it, 3 a texel: a pixel's colour says which texel it shows. */
  const RAMP = Array.from({ length: 4 }, () =>
    Uint32Array.from({ length: TEX * TEX }, (_, texel) =>
      rgb(8 + 3 * (texel % TEX), 100, 8 + 3 * Math.floor(texel / TEX))
    )
  );
  const fb = createFramebuffer();

  test.each([
    ['east', 0, 1],
    ['south', Math.PI / 2, 0.7],
    ['west', Math.PI, 1],
    ['north', -Math.PI / 2, 0.7],
  ] as const)('facing the %s wall, a pixel is the texel renderWalls shows, give or take a row', (_, angle, shade) => {
    // Light of 1 everywhere, so a wall pixel is its texture's linear colour.
    const world = buildTracedWorld(ROOM, RAMP, []);
    const maps = createLightmaps(world);
    maps.wall.fill(1);
    const eye = { ...MIDDLE, angle };
    draw(fb, eye, { world, maps });
    const reference = createFramebuffer();
    renderWalls(reference, { map: ROOM, eye, textures: RAMP, lighting: null });
    const { hdr, wallStart, wallEnd } = lastTracedBuffers();
    const columnsOff: number[] = [];
    const rowsOff: number[] = [];
    for (let col = 0; col < fb.width; col++) {
      for (let row = wallStart.at(col) ?? 0; row < (wallEnd.at(col) ?? 0); row++) {
        const pixel = row * fb.width + col;
        const shown = reference.pixels.at(pixel) ?? 0;
        // renderWalls darkens the y-side faces to 0.7, rounding down. A texel is 3 bytes from the next one.
        const redDiffers = Math.abs(byteOfLinear(hdr.at(pixel * 3) ?? 0) * shade - (shown & 0xff)) > 3;
        // The traced room samples a pixel at its centre and renderWalls at its top: up to a texel row apart.
        const blueDiffers = Math.abs(byteOfLinear(hdr.at(pixel * 3 + 2) ?? 0) * shade - ((shown >>> 16) & 0xff)) > 4;
        if (redDiffers) {
          columnsOff.push(col);
        }
        if (blueDiffers) {
          rowsOff.push(row);
        }
      }
    }
    expect(columnsOff).toEqual([]);
    expect(rowsOff).toEqual([]);
  });
});

describe("a wall out of the ray walk's reach", () => {
  test('leaves no pixel unwritten or NaN, in a frame of odd height', () => {
    // castRay gives up after 256 cells, so down a corridor this long it finds no wall: its columns show no wall at all.
    const corridor = parseMap(['1'.repeat(300), `1S${'.'.repeat(297)}1`, '1'.repeat(300)].join('\n'));
    const world = buildTracedWorld(corridor, TEXTURES, []);
    const traced = { world, maps: createLightmaps(world) };
    const odd = createFramebuffer(301, 361, fovForAspect(301 / 361));
    draw(odd, { x: 1.5, y: 1.5, angle: 0 }, traced);
    expect(Math.max(...odd.zbuffer)).toBe(Number.POSITIVE_INFINITY);
    expect(opaqueEverywhere(odd)).toBe(true);
    expect(lastTracedBuffers().hdr.every(Number.isFinite)).toBe(true);
  });
});
