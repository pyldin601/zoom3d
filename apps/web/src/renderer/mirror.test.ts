import { describe, expect, test } from 'vitest';
import { createFramebuffer, rgb } from './framebuffer';
import { createFloorMirror } from './mirror';

// Floor mirror spec §3: images plotted into one layer, blurred once, then added over the floor.
const RED = rgb(200, 0, 0);
const GREY = rgb(100, 100, 100);

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
    // Blocks a whole blur texel wide and tall, so each texel is one or the other.
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) {
        m.plot(x, y, RED, 'shows');
        m.plot(x + 16, y, RED, 'hides');
      }
    }
    m.blur(flat(0));
    expect(m.coverageAt(12, 12)).toBe(1);
    expect(m.hidingAt(12, 12)).toBe(0);
    expect(m.coverageAt(28, 12)).toBe(1);
    expect(m.hidingAt(28, 12)).toBe(1);
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

  test('the blur keeps an image whole up to the frame’s edges', () => {
    const m = mirrorOf();
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        m.plot(x, y, RED, 'shows');
      }
    }
    m.blur(flat(8));
    for (const [x, y] of [
      [0, 20],
      [39, 20],
      [20, 39],
      [0, 39],
      [39, 0],
    ] as const) {
      expect(m.coverageAt(x, y)).toBeCloseTo(1, 5);
    }
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
