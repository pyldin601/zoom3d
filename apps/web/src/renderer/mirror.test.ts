import { describe, expect, test } from 'vitest';
import { createFramebuffer, rgb } from './framebuffer';
import { createMirrorBuffer, createMirrorLayer, type ScreenBox } from './mirror';

// Voxel shadows spec §3.3: the objects' mirror is drawn into a scratch buffer, blurred, then mixed over the floor.
const RED = rgb(200, 0, 0);
const GREY = rgb(100, 100, 100);
const box: ScreenBox = { left: 10, top: 10, right: 30, bottom: 30 };

/** A mirror buffer for a 40 × 40 frame with a 3 × 3 red block plotted at (19..21, 19..21). */
function withBlock() {
  const mirror = createMirrorBuffer();
  mirror.fit(40, 40);
  mirror.clear(box);
  for (let y = 19; y < 22; y++) {
    for (let x = 19; x < 22; x++) {
      mirror.plot(x, y, RED);
    }
  }
  return mirror;
}

describe('MirrorBuffer', () => {
  test('blur keeps the total coverage and spreads it by its radius', () => {
    const mirror = withBlock();
    mirror.blur(box, 2);
    let total = 0;
    for (let y = box.top; y < box.bottom; y++) {
      for (let x = box.left; x < box.right; x++) {
        total += mirror.coverageAt(x, y);
      }
    }
    expect(total).toBeCloseTo(9, 5);
    expect(mirror.coverageAt(17, 20)).toBeGreaterThan(0);
    expect(mirror.coverageAt(16, 20)).toBe(0);
  });

  test('clear empties only its box', () => {
    const mirror = withBlock();
    mirror.clear({ left: 19, top: 19, right: 20, bottom: 20 });
    expect(mirror.coverageAt(19, 19)).toBe(0);
    expect(mirror.coverageAt(20, 20)).toBe(1);
  });
});

describe('MirrorLayer', () => {
  const layerOf = (...weights: number[]) => {
    const layer = createMirrorLayer();
    layer.fit(40, 40);
    layer.clear();
    for (const weight of weights) {
      layer.merge(withBlock(), box, weight);
    }
    return layer;
  };

  test('merging covers as the object did, times its weight', () => {
    const layer = layerOf(0.5);
    expect(layer.coverageAt(20, 20)).toBeCloseTo(0.5);
    expect(layer.coverageAt(10, 10)).toBe(0);
  });

  test('a nearer image over a farther one covers more, never past whole', () => {
    const layer = layerOf(0.5, 0.5);
    expect(layer.coverageAt(20, 20)).toBeCloseTo(0.75);
    expect(layerOf(1, 1).coverageAt(20, 20)).toBe(1);
  });

  test('clear empties what the last frame merged', () => {
    const layer = layerOf(1);
    layer.clear();
    expect(layer.coverageAt(20, 20)).toBe(0);
  });

  test('adds its colour at a strength, on floor rows only', () => {
    const layer = layerOf(1);
    const fb = createFramebuffer(40, 40);
    fb.pixels.fill(GREY);
    layer.addInto(fb, 0.5, new Int32Array(40).fill(20));
    expect(fb.pixels[19 * 40 + 20]).toBe(GREY);
    expect(fb.pixels[20 * 40 + 20]).toBe(rgb(200, 100, 100));
  });

  test('strength 0 adds nothing', () => {
    const layer = layerOf(1);
    const fb = createFramebuffer(40, 40);
    fb.pixels.fill(GREY);
    layer.addInto(fb, 0, new Int32Array(40));
    expect(fb.pixels.every((p) => p === GREY)).toBe(true);
  });
});
