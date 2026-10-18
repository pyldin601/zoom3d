import { describe, expect, test } from 'vitest';
import { createFramebuffer } from '../framebuffer';
import { createEmptyTracedBuffers, fitTracedBuffers, type TracedBuffers } from './buffers';
import {
  blurReflectedSurfaces,
  FLOOR_SURFACE,
  NARROWEST_TENT,
  NO_SURFACE,
  TENT_PER_DEVIATION,
  UNPLACED_WALL_SURFACE,
  wallSurface,
} from './surface-blur';
import { FACE_EAST, FACE_NORTH, FACE_SOUTH, FACE_WEST, NO_FACE } from './world';

const WALL = wallSurface(FACE_NORTH, 3);

/** Reflection buffers `width` × `height` samples, every sample the floor's, unlit and with the narrowest tents. */
function samples(width: number, height: number): TracedBuffers {
  const fb = createFramebuffer(width * 2, height * 2);
  const buffers = fitTracedBuffers(createEmptyTracedBuffers(), fb, { x: 0, y: 0, angle: 0 });
  buffers.surfaceKind.fill(FLOOR_SURFACE);
  buffers.tentAcross.fill(NARROWEST_TENT);
  buffers.tentUp.fill(NARROWEST_TENT);
  return buffers;
}

/** The tent's half width (samples) for a cone `deviation` samples wide, as the reflections keep it. */
function tentOf(deviation: number): number {
  return Math.max(NARROWEST_TENT, deviation * TENT_PER_DEVIATION);
}

/** Sample (col, row)'s red after the blur. */
function blurredRed(buffers: TracedBuffers, col: number, row: number): number {
  return buffers.blurredSurface.at((row * buffers.reflectedWidth + col) * 3) ?? 0;
}

/** Sets every sample's red to `light(col, row)`. */
function paint(buffers: TracedBuffers, light: (col: number, row: number) => number): void {
  for (let row = 0; row < buffers.reflectedHeight; row++) {
    for (let col = 0; col < buffers.reflectedWidth; col++) {
      buffers.reflectedSurface[(row * buffers.reflectedWidth + col) * 3] = light(col, row);
    }
  }
}

describe('blurReflectedSurfaces', () => {
  test('leaves an even light even, out to the ends of each run, however wide the cone', () => {
    const buffers = samples(64, 8);
    paint(buffers, () => 0.3);
    for (const deviation of [0.2, 3, 40, 500]) {
      buffers.tentAcross.fill(tentOf(deviation));
      buffers.tentUp.fill(tentOf(deviation));
      blurReflectedSurfaces(buffers);
      for (const col of [0, 1, 31, 62, 63]) {
        expect(blurredRed(buffers, col, 0), `deviation ${deviation}, column ${col}`).toBeCloseTo(0.3, 5);
      }
    }
  });

  test('leaves a sample as it is where the cone is narrower than a sample', () => {
    const buffers = samples(32, 4);
    paint(buffers, (col, row) => (col * 7 + row * 3) % 5);
    buffers.tentAcross.fill(tentOf(0.2));
    buffers.tentUp.fill(tentOf(0.2));
    blurReflectedSurfaces(buffers);
    for (let at = 0; at < buffers.blurredSurface.length; at++) {
      expect(buffers.blurredSurface.at(at)).toBeCloseTo(buffers.reflectedSurface.at(at) ?? 0, 5);
    }
  });

  test('spreads a step over as many samples as the cone is wide, smoothly and symmetrically', () => {
    const buffers = samples(200, 2);
    paint(buffers, (col) => (col < 100 ? 0 : 1));
    for (const deviation of [2, 5, 10]) {
      buffers.tentAcross.fill(tentOf(deviation));
      blurReflectedSurfaces(buffers);
      const row = Array.from({ length: 200 }, (_, col) => blurredRed(buffers, col, 0));
      for (let col = 1; col < 200; col++) {
        expect(row.at(col) ?? 0, `deviation ${deviation}, column ${col}`).toBeGreaterThanOrEqual(
          (row.at(col - 1) ?? 0) - 1e-6
        );
      }
      // The step lies between columns 99 and 100: they are as far from the middle either way, to within the 1% each
      // that a line between worked-out tents may miss by.
      expect(Math.abs((row.at(99) ?? 0) + (row.at(100) ?? 0) - 1), `deviation ${deviation}`).toBeLessThan(0.02);
      // A Gaussian rises from 10% to 90% over 2.56 deviations.
      const rise = row.filter((light) => light > 0.1 && light < 0.9).length;
      expect(rise, `deviation ${deviation}`).toBeGreaterThanOrEqual(Math.floor(2.56 * deviation * 0.85));
      expect(rise, `deviation ${deviation}`).toBeLessThanOrEqual(Math.ceil(2.56 * deviation * 1.15));
    }
  });

  test('never mixes two surfaces, nor takes anything from the ceiling', () => {
    const buffers = samples(40, 30);
    // A wall over the floor, the ceiling over the wall; the floor dark, the wall and the ceiling bright.
    for (let row = 0; row < 30; row++) {
      const kind = row < 5 ? NO_SURFACE : row < 15 ? WALL : FLOOR_SURFACE;
      buffers.surfaceKind.fill(kind, row * 40, row * 40 + 40);
    }
    paint(buffers, (_, row) => (row < 15 ? 100 : 0.01));
    buffers.tentAcross.fill(tentOf(30));
    buffers.tentUp.fill(tentOf(30));
    blurReflectedSurfaces(buffers);
    for (let col = 0; col < 40; col++) {
      expect(blurredRed(buffers, col, 15)).toBeCloseTo(0.01, 6);
      expect(blurredRed(buffers, col, 14)).toBeCloseTo(100, 3);
      expect(blurredRed(buffers, col, 4)).toBe(0);
    }
  });

  describe('wallSurface', () => {
    test("gives every face on every map line its own kind, none of them the floor's, the ceiling's or an unplaced wall's", () => {
      const kinds = new Set<number>();
      for (let line = 0; line < 64; line++) {
        for (const face of [FACE_WEST, FACE_EAST, FACE_NORTH, FACE_SOUTH]) {
          kinds.add(wallSurface(face, line));
        }
      }
      expect(kinds.size).toBe(64 * 4);
      for (const other of [NO_SURFACE, FLOOR_SURFACE, UNPLACED_WALL_SURFACE]) {
        expect(kinds.has(other), `kind ${other}`).toBe(false);
      }
    });

    test('takes a wall with no face, or off the map, as unplaced: never the floor nor another plane', () => {
      for (const line of [0, 1, 7]) {
        expect(wallSurface(NO_FACE, line)).toBe(UNPLACED_WALL_SURFACE);
      }
      expect(wallSurface(FACE_NORTH, -1)).toBe(UNPLACED_WALL_SURFACE);
      expect(wallSurface(4, 0)).toBe(UNPLACED_WALL_SURFACE);
    });
  });
});
