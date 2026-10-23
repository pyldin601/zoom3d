import { describe, expect, test } from 'vitest';
import { createFramebuffer, rgb } from './framebuffer';
import { createFloorMirror, createMirrorBuffer, createMirrorLayer, type ScreenBox } from './mirror';

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

describe('FloorMirror', () => {
  const BLUE = rgb(0, 0, 200);
  const mirrorOf = (width = 40, height = 40) => {
    const m = createFloorMirror();
    m.fit(width, height);
    m.clear();
    return m;
  };
  const flat = (r: number) => new Float64Array(40).fill(r);
  const ones = new Float64Array(40).fill(1);

  test('a nearer plot covers a farther one', () => {
    const m = mirrorOf();
    for (let y = 18; y < 24; y++) {
      for (let x = 18; x < 24; x++) {
        m.plot(x, y, RED, 'shows');
        m.plot(x, y, BLUE, 'shows');
      }
    }
    m.blur(flat(0));
    expect(m.coverageAt(20, 20)).toBe(1);
    const fb = createFramebuffer(40, 40);
    fb.pixels.fill(rgb(0, 0, 0));
    m.addInto(fb, 1, ones, new Int32Array(40));
    expect(fb.pixels[20 * 40 + 20]).toBe(BLUE);
  });

  test('shows and hides are kept apart', () => {
    const m = mirrorOf();
    for (let y = 10; y < 14; y++) {
      for (let x = 10; x < 14; x++) {
        m.plot(x, y, RED, 'shows');
        m.plot(x + 10, y, RED, 'hides');
      }
    }
    m.blur(flat(0));
    expect(m.coverageAt(12, 12)).toBe(1);
    expect(m.hidingAt(12, 12)).toBe(0);
    expect(m.coverageAt(22, 12)).toBe(1);
    expect(m.hidingAt(22, 12)).toBe(1);
  });

  test('the blur keeps a row’s coverage and is wider where the row’s radius is', () => {
    const m = mirrorOf();
    for (let y = 4; y < 40; y++) {
      for (let x = 16; x < 24; x++) {
        m.plot(x, y, RED, 'shows');
      }
    }
    const radius = Float64Array.from({ length: 40 }, (_, y) => (y < 20 ? 2 : 8));
    m.blur(radius);
    const across = (y: number) => [...Array(40).keys()].map((x) => m.coverageAt(x, y));
    const sum = (row: number[]) => row.reduce((a, b) => a + b, 0);
    const reach = (row: number[]) => row.filter((c) => c > 0).length;
    expect(sum(across(15))).toBeCloseTo(8, 0);
    expect(sum(across(25))).toBeCloseTo(8, 0);
    expect(reach(across(25)) - reach(across(15))).toBeGreaterThanOrEqual(4);
  });

  test('clear empties what was plotted', () => {
    const m = mirrorOf();
    m.plot(20, 20, RED, 'hides');
    m.clear();
    m.blur(flat(2));
    expect(m.coverageAt(20, 20)).toBe(0);
    expect(m.rows.bottom - m.rows.top).toBe(0);
  });

  test('adds on floor rows only, times each row’s weight', () => {
    const m = mirrorOf();
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        m.plot(x, y, RED, 'shows');
      }
    }
    m.blur(flat(0));
    const fb = createFramebuffer(40, 40);
    fb.pixels.fill(GREY);
    m.addInto(fb, 1, new Float64Array(40).fill(0.5), new Int32Array(40).fill(20));
    expect(fb.pixels[19 * 40 + 20]).toBe(GREY);
    expect(fb.pixels[30 * 40 + 20]).toBe(rgb(200, 100, 100));
  });

  test('refits to a new frame size', () => {
    const m = mirrorOf();
    m.plot(20, 20, RED, 'shows');
    m.fit(60, 30);
    m.clear();
    m.blur(new Float64Array(30).fill(2));
    expect(m.coverageAt(20, 20)).toBe(0);
  });
});
