import { describe, expect, test } from 'vitest';
import {
  FOV_WIDE,
  fitTouchViewport,
  fitViewport,
  fovForAspect,
  INTERNAL_H,
  INTERNAL_W,
  type ViewportBox,
} from './viewport';

function expectSane(box: ViewportBox, w: number, h: number) {
  for (const v of [box.x, box.y, box.width, box.height]) {
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  }
  expect(box.width * 9).toBe(box.height * 16);
  const safe = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  expect(box.x + box.width).toBeLessThanOrEqual(safe(w));
  expect(box.y + box.height).toBeLessThanOrEqual(safe(h));
}

describe('fitViewport', () => {
  test('internal resolution is 16:9', () => {
    expect([INTERNAL_W, INTERNAL_H]).toEqual([640, 360]);
  });

  test.each([
    [1920, 1080, { x: 0, y: 0, width: 1920, height: 1080 }],
    [1920, 1200, { x: 0, y: 60, width: 1920, height: 1080 }],
    [800, 1000, { x: 0, y: 275, width: 800, height: 450 }],
    [333, 777, { x: 6, y: 298, width: 320, height: 180 }],
    [2560, 1080, { x: 320, y: 0, width: 1920, height: 1080 }],
  ])('%i x %i letterboxes to a centred 16:9 box', (w, h, expected) => {
    const box = fitViewport(w, h);
    expect(box).toEqual(expected);
    expectSane(box, w, h);
  });

  test.each([
    [0, 0],
    [1, 1],
    [15, 1000],
    [Number.NaN, 500],
    [-10, -10],
  ])('degenerate window %s x %s gives a finite empty-or-small box', (w, h) => {
    const box = fitViewport(w, h);
    expectSane(box, w, h);
  });

  test('pixel-perfect snaps to an integer multiple of the internal resolution', () => {
    expect(fitViewport(1500, 900, true)).toEqual({ x: 110, y: 90, width: 1280, height: 720 });
  });

  test('pixel-perfect falls back to the plain fit when 1x does not fit', () => {
    const box = fitViewport(500, 300, true);
    expect(box).toEqual({ x: 2, y: 10, width: 496, height: 279 });
    expectSane(box, 500, 300);
  });
});

describe('fovForAspect', () => {
  const deg = (r: number) => (r * 180) / Math.PI;
  test.each([
    [16 / 9, 66],
    [2.5, 66],
    [9 / 19.5, 50],
    [0.3, 50],
  ])('aspect %f gives %f°', (a, d) => {
    expect(deg(fovForAspect(a))).toBeCloseTo(d, 6);
  });

  test('interpolates linearly in aspect', () => {
    const mid = (16 / 9 + 9 / 19.5) / 2;
    expect(deg(fovForAspect(mid))).toBeCloseTo(58, 6);
  });

  test('degenerate aspect falls back to the wide FOV', () => {
    expect(fovForAspect(Number.NaN)).toBe(FOV_WIDE);
  });
});

describe('fitTouchViewport', () => {
  test('portrait phone fills the window with a 296x640 buffer at ~50°', () => {
    const f = fitTouchViewport(390, 844);
    expect(f.box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    expect([f.width, f.height]).toEqual([296, 640]);
    expect(f.fov).toBeCloseTo(fovForAspect(296 / 640), 9);
  });

  test('landscape phone is 640x296 at 66°', () => {
    const f = fitTouchViewport(844, 390);
    expect([f.width, f.height]).toEqual([640, 296]);
    expect(f.fov).toBe(FOV_WIDE);
  });

  test.each([
    [0, 0],
    [Number.NaN, 500],
    [1, 2000],
  ])('degenerate %s x %s stays finite with an even buffer of at least 2 px', (w, h) => {
    const f = fitTouchViewport(w, h);
    expect(f.width).toBeGreaterThanOrEqual(2);
    expect(f.height).toBeGreaterThanOrEqual(2);
    expect((f.width % 2) + (f.height % 2)).toBe(0);
    expect(Number.isFinite(f.fov)).toBe(true);
  });
});
