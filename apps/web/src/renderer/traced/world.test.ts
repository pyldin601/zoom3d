import { parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { rgb } from '../framebuffer';
import { GLOSS, makeTextures } from '../textures';
import { CEILING, FLOOR } from '../walls';
import {
  buildTracedWorld,
  FACE_EAST,
  FACE_NORMAL_X,
  FACE_NORMAL_Y,
  FACE_NORTH,
  FACE_SOUTH,
  FACE_WEST,
  isWall,
  LAMP_RADIANCE,
  LAMP_RADIUS,
  lampOver,
  TRACED_MATERIALS,
} from './world';

const NO_TEXTURES: Uint32Array[] = [];
const CORRIDOR = parseMap('111111\n1S...1\n111111');
/** One lamp in the middle of the second tile, and one on the boundary between the fourth and fifth. */
const LAMPS = [
  { x: 1.5, y: 1.5 },
  { x: 4, y: 1.5 },
];

function cellOf(map: { width: number }, x: number, y: number): number {
  return y * map.width + x;
}

describe('the lamp', () => {
  test('is the game fixture: a disc 0.18 tiles wide, 36 bright', () => {
    expect([LAMP_RADIUS, LAMP_RADIANCE]).toEqual([0.18, 36]);
  });

  test('radiance is the warm tint in linear light: 1, 0.84^2.2, 0.6^2.2', () => {
    const world = buildTracedWorld(CORRIDOR, NO_TEXTURES, LAMPS);
    expect(world.lampRgb.at(0)).toBe(36);
    expect(world.lampRgb.at(1)).toBeCloseTo(36 * 0.84 ** 2.2, 4);
    expect(world.lampRgb.at(2)).toBeCloseTo(36 * 0.6 ** 2.2, 4);
  });

  test('positions are kept as given', () => {
    const world = buildTracedWorld(CORRIDOR, NO_TEXTURES, LAMPS);
    expect(Array.from(world.lampX)).toEqual([1.5, 4]);
    expect(Array.from(world.lampY)).toEqual([1.5, 1.5]);
  });
});

describe('lampOver', () => {
  const world = buildTracedWorld(CORRIDOR, NO_TEXTURES, LAMPS);

  test('is the lamp at its centre and nothing 0.19 tiles away', () => {
    expect(lampOver(world, 1.5, 1.5)).toBe(0);
    expect(lampOver(world, 1.5 + 0.19, 1.5)).toBe(-1);
    expect(lampOver(world, 1.5, 1.5 - 0.19)).toBe(-1);
  });

  test('covers the disc but not its corner square', () => {
    expect(lampOver(world, 1.5 + 0.17, 1.5)).toBe(0);
    expect(lampOver(world, 1.5 + 0.17, 1.5 + 0.17)).toBe(-1);
  });

  test('finds a disc that straddles two tiles from either side', () => {
    expect(lampOver(world, 3.9, 1.5)).toBe(1);
    expect(lampOver(world, 4.1, 1.5)).toBe(1);
    expect(lampOver(world, 4.2, 1.5)).toBe(-1);
  });

  test('is nothing off the map, including the column that wraps to the previous row', () => {
    expect(lampOver(world, -0.01, 1.5)).toBe(-1);
    expect(lampOver(world, 6, 1.5)).toBe(-1);
    expect(lampOver(world, 1.5, -0.5)).toBe(-1);
    expect(lampOver(world, 1.5, 3)).toBe(-1);
  });
});

describe('isWall', () => {
  const world = buildTracedWorld(CORRIDOR, NO_TEXTURES, LAMPS);

  test('is true for wall tiles and false for floor', () => {
    expect(isWall(world, 0, 1)).toBe(true);
    expect(isWall(world, 1, 1)).toBe(false);
    expect(isWall(world, 4, 1)).toBe(false);
    expect(isWall(world, 5, 1)).toBe(true);
  });

  test('is true off the map', () => {
    expect(isWall(world, -1, 1)).toBe(true);
    expect(isWall(world, 1, -1)).toBe(true);
    expect(isWall(world, 6, 1)).toBe(true);
    expect(isWall(world, 1, 3)).toBe(true);
  });
});

describe('wall faces', () => {
  const world = buildTracedWorld(CORRIDOR, NO_TEXTURES, LAMPS);
  const faceOf = (x: number, y: number, side: number) => world.faceIndex.at(cellOf(CORRIDOR, x, y) * 4 + side);

  test('face sides and their normals point into the open cell in front', () => {
    expect([FACE_WEST, FACE_EAST, FACE_NORTH, FACE_SOUTH]).toEqual([0, 1, 2, 3]);
    expect(Array.from(FACE_NORMAL_X)).toEqual([-1, 1, 0, 0]);
    expect(Array.from(FACE_NORMAL_Y)).toEqual([0, 0, -1, 1]);
  });

  test('a face with floor in front has an index', () => {
    expect(faceOf(1, 0, FACE_SOUTH)).toBeGreaterThanOrEqual(0);
    expect(faceOf(0, 1, FACE_EAST)).toBeGreaterThanOrEqual(0);
    expect(faceOf(5, 1, FACE_WEST)).toBeGreaterThanOrEqual(0);
    expect(faceOf(3, 2, FACE_NORTH)).toBeGreaterThanOrEqual(0);
  });

  test('a face with a wall in front, or the map edge, has none', () => {
    expect(faceOf(1, 0, FACE_WEST)).toBe(-1);
    expect(faceOf(1, 0, FACE_EAST)).toBe(-1);
    expect(faceOf(1, 0, FACE_NORTH)).toBe(-1);
    expect(faceOf(0, 0, FACE_SOUTH)).toBe(-1);
  });

  test('no face is indexed in an open cell', () => {
    for (let side = 0; side < 4; side++) {
      expect(faceOf(2, 1, side)).toBe(-1);
    }
  });

  test('visible faces are numbered 0..faceCount-1 in cell order, each once', () => {
    const indices = Array.from(world.faceIndex).filter((index) => index >= 0);
    const endFaces = 2;
    const facesAboveAndBelowTheRow = 4 + 4;
    expect(world.faceCount).toBe(endFaces + facesAboveAndBelowTheRow);
    expect(indices).toEqual(Array.from({ length: world.faceCount }, (_, i) => i));
  });
});

describe('the traced world', () => {
  test('knows the map and its size', () => {
    const world = buildTracedWorld(CORRIDOR, NO_TEXTURES, LAMPS);
    expect([world.map, world.width, world.height]).toEqual([CORRIDOR, 6, 3]);
    expect(world.lampAt.length).toBe(18);
  });

  test('has material for every tile, with the spec table', () => {
    expect(TRACED_MATERIALS).toEqual([
      { f0: 0.04, roughness: 0.6, tint: 0 },
      { f0: 0.04, roughness: 0.85, tint: 0.6 },
      { f0: 0.04, roughness: 0.35, tint: 0.75 },
      { f0: 0.04, roughness: 0.85, tint: 0.85 },
    ]);
  });

  test('turns texture colours into linear light, and keeps their mean', () => {
    const black = rgb(0, 0, 0);
    const white = rgb(255, 255, 255);
    const orange = rgb(255, 128, 0);
    const textures = [
      new Uint32Array(0),
      Uint32Array.of(orange, black),
      Uint32Array.of(white, white),
      new Uint32Array(0),
    ];
    const world = buildTracedWorld(CORRIDOR, textures, LAMPS);
    const orangeLinear = [1, ((128 / 255 + 0.055) / 1.055) ** 2.4, 0];
    const albedo = world.albedo.at(1);
    expect(albedo?.length).toBe(6);
    expect(Array.from(albedo?.subarray(0, 3) ?? [])).toEqual(orangeLinear.map((c) => expect.closeTo(c, 5)));
    expect(Array.from(albedo?.subarray(3) ?? [])).toEqual([0, 0, 0]);
    expect(Array.from(world.meanAlbedo.at(1) ?? [])).toEqual(orangeLinear.map((c) => expect.closeTo(c / 2, 5)));
    expect(Array.from(world.meanAlbedo.at(2) ?? [])).toEqual([1, 1, 1]);
  });

  test('a tile with no texture has an empty albedo and a black mean', () => {
    const world = buildTracedWorld(CORRIDOR, makeTextures(1), LAMPS);
    expect(world.albedo.at(0)?.length).toBe(0);
    expect(Array.from(world.meanAlbedo.at(0) ?? [])).toEqual([0, 0, 0]);
    expect(world.albedo.at(1)?.length).toBe(64 * 64 * 3);
  });

  test('takes gloss from the game, and floor and ceiling colour from the unlit room', () => {
    const world = buildTracedWorld(CORRIDOR, NO_TEXTURES, LAMPS);
    expect(world.gloss).toBe(GLOSS);
    const linear = (packed: number) => (((packed & 0xff) / 255 + 0.055) / 1.055) ** 2.4;
    expect(world.floorAlbedo.at(0)).toBeCloseTo(linear(FLOOR), 5);
    expect(world.floorAlbedo.at(2)).toBeCloseTo(linear(FLOOR), 5);
    expect(world.ceilingAlbedo.at(1)).toBeCloseTo(linear(CEILING), 5);
    expect(world.floorAlbedo.length).toBe(3);
  });
});
