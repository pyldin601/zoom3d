// Test helpers for the traced room: a whole bake, where a point of the room lands in a frame, and whether a frame
// writes every pixel.
import type { GameMap, PlayerState } from '@zoom3d/shared';
import { expect } from 'vitest';
import { createView, EYE_HEIGHT, setView } from '../camera';
import type { Framebuffer } from '../framebuffer';
import type { Sprite } from '../sprites';
import { bakeLighting } from './bake';
import { lastTracedBuffers, renderTraced, type TracedLighting } from './frame';
import { createLightmaps } from './lightmaps';
import { buildTracedWorld } from './world';

export function bakeRoom(
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

/** The pixel that shows the point (x, y) at height z (0 floor .. 1 ceiling) from `eye`. */
export function pixelOf(
  fb: Framebuffer,
  eye: PlayerState,
  x: number,
  y: number,
  z: number
): { col: number; row: number } {
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

/**
 * Draws a frame, then draws it again over buffers and a z-buffer full of NaN: what the passes skip stays NaN. The frame's
 * own pixels can't show a gap, since the tone map writes every pixel from whatever light is there.
 */
export function drawOverNaN(
  fb: Framebuffer,
  eye: PlayerState,
  traced: TracedLighting,
  people: readonly Sprite[] = []
): void {
  const scene = { map: traced.world.map, eye, people, traced };
  renderTraced(fb, scene);
  const { hdr, spec, widenedReflection } = lastTracedBuffers();
  hdr.fill(Number.NaN);
  spec.fill(Number.NaN);
  for (const samples of reflectionSamples()) {
    samples.fill(Number.NaN);
  }
  widenedReflection.fill(Number.NaN);
  fb.zbuffer.fill(Number.NaN);
  fb.pixels.fill(0);
  renderTraced(fb, scene);
}

/** Every per-sample reflection buffer the last frame wrote. */
function reflectionSamples(): Float32Array[] {
  const buffers = lastTracedBuffers();
  return [
    buffers.reflected,
    buffers.reflectedSurface,
    buffers.reflectedKeep,
    buffers.reflectedOver,
    buffers.coneAcross,
    buffers.coneUp,
    buffers.blurredSurface,
  ];
}

/**
 * For a frame drawn by `drawOverNaN`: every pixel opaque, every light (reflected ones too) and weight a number, every
 * column a distance.
 */
export function expectEveryPixelWritten(fb: Framebuffer): void {
  const { hdr, spec, widenedReflection } = lastTracedBuffers();
  expect(fb.pixels.findIndex((pixel) => pixel >>> 24 !== 0xff)).toBe(-1);
  expect(hdr.findIndex((light) => !Number.isFinite(light))).toBe(-1);
  expect(spec.findIndex((weight) => !Number.isFinite(weight))).toBe(-1);
  for (const [index, samples] of reflectionSamples().entries()) {
    expect(
      samples.findIndex((value) => !Number.isFinite(value)),
      `reflection buffer ${index}`
    ).toBe(-1);
  }
  expect(widenedReflection.findIndex((light) => !Number.isFinite(light))).toBe(-1);
  expect(fb.zbuffer.findIndex((distance) => !(distance > 0))).toBe(-1);
}
