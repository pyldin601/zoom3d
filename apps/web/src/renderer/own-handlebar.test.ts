import { describe, expect, test } from 'vitest';
import { createFramebuffer, type Framebuffer } from './framebuffer';
import { renderOwnHandlebar } from './own-handlebar';
import { ownTexel } from './own-held';
import { hexToRgb } from './sprites';

function drawn(steer: number, head = 0): { fb: Framebuffer; cols: number[]; rows: number[] } {
  const fb = createFramebuffer();
  fb.pixels.fill(0);
  renderOwnHandlebar(fb, steer, head);
  const cols: number[] = [];
  const rows: number[] = [];
  fb.pixels.forEach((c, i) => {
    if (c !== 0) {
      cols.push(i % fb.width);
      rows.push(Math.floor(i / fb.width));
    }
  });
  return { fb, cols, rows };
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** The lowest drawn row among the columns at the far left (or right) of the bar: where that grip hangs. */
function gripBottom(d: ReturnType<typeof drawn>, side: 'left' | 'right'): number {
  const edge = side === 'left' ? Math.min(...d.cols) : Math.max(...d.cols);
  const rowsAtEdge = d.rows.filter((_, i) => d.cols[i] === edge);
  return Math.max(...rowsAtEdge);
}

describe('renderOwnHandlebar', () => {
  test('draws at the bottom centre, leaving the top half alone', () => {
    const d = drawn(0);
    expect(d.cols.length).toBeGreaterThan(0);
    expect(Math.min(...d.rows)).toBeGreaterThan(d.fb.height / 2);
    expect(Math.max(...d.rows)).toBe(d.fb.height - 1);
    expect(mean(d.cols)).toBeCloseTo(d.fb.width / 2, -1);
  });

  test('steering right shifts it right and tilts it: the right grip down, the left one up', () => {
    const straight = drawn(0);
    const right = drawn(1);
    // Its edges, not its centroid: the lowered grip is partly cropped by the bottom edge.
    expect(Math.min(...right.cols)).toBeGreaterThan(Math.min(...straight.cols));
    expect(Math.max(...right.cols)).toBeGreaterThan(Math.max(...straight.cols));
    expect(gripBottom(right, 'right')).toBeGreaterThan(gripBottom(straight, 'right'));
    expect(gripBottom(right, 'left')).toBeLessThan(gripBottom(straight, 'left'));
  });

  test('a tilted bar slopes in one piece: its top edge never steps much more than a texel', () => {
    const d = drawn(1);
    const topByCol = new Map<number, number>();
    d.cols.forEach((c, i) => {
      topByCol.set(c, Math.min(topByCol.get(c) ?? Number.POSITIVE_INFINITY, d.rows.at(i) ?? 0));
    });
    const cols = [...topByCol.keys()].sort((a, b) => a - b);
    const texel = ownTexel(d.fb);
    for (let i = 1; i < cols.length; i++) {
      const step = Math.abs((topByCol.get(cols.at(i) ?? 0) ?? 0) - (topByCol.get(cols.at(i - 1) ?? 0) ?? 0));
      // A grip stands a texel proud of the bar; anything more is the bar coming apart.
      expect(step).toBeLessThanOrEqual(1.5 * texel);
    }
  });

  test('steering left mirrors it', () => {
    const right = drawn(1);
    const left = drawn(-1);
    const w = right.fb.width;
    expect(Math.min(...left.cols)).toBeCloseTo(w - 1 - Math.max(...right.cols), -1);
    expect(gripBottom(left, 'left')).toBe(gripBottom(right, 'right'));
  });
});

const SKIN = ['#f2c29b', '#c98d6a', '#8a5236'].map(hexToRgb);
const GRIP = ['#26262a', '#3d3d44'].map(hexToRgb);
/** The drawn pixels in hand colours, left or right of the screen's middle. */
function fistPixels(d: ReturnType<typeof drawn>, side: 'left' | 'right'): { cols: number[]; rows: number[] } {
  const cols: number[] = [];
  const rows: number[] = [];
  d.fb.pixels.forEach((c, i) => {
    const col = i % d.fb.width;
    if (SKIN.includes(c) && (side === 'left') === col < d.fb.width / 2) {
      cols.push(col);
      rows.push(Math.floor(i / d.fb.width));
    }
  });
  return { cols, rows };
}

describe('the hands on the grips', () => {
  test("a fist in the held items' hand colours closes over each grip, hiding it", () => {
    const d = drawn(0);
    expect(fistPixels(d, 'left').cols.length).toBeGreaterThan(0);
    expect(fistPixels(d, 'right').cols.length).toBeGreaterThan(0);
    expect([...d.fb.pixels].some((c) => GRIP.includes(c))).toBe(false);
  });

  test('a tilted grip stays hidden under its fist', () => {
    for (const steer of [-1, -0.5, 0.5, 1]) {
      expect([...drawn(steer).fb.pixels].some((c) => GRIP.includes(c))).toBe(false);
    }
  });

  test('the fists sit at the ends of the bar, mirrored', () => {
    const d = drawn(0);
    const w = d.fb.width;
    expect(Math.min(...fistPixels(d, 'left').cols)).toBe(Math.min(...d.cols));
    expect(Math.max(...fistPixels(d, 'right').cols)).toBe(Math.max(...d.cols));
    expect(Math.min(...fistPixels(d, 'left').cols)).toBeCloseTo(w - 1 - Math.max(...fistPixels(d, 'right').cols), -1);
  });

  test('steering right takes the right fist down and the left one up, with the grips', () => {
    const straight = drawn(0);
    const right = drawn(1);
    const top = (d: ReturnType<typeof drawn>, side: 'left' | 'right') => Math.min(...fistPixels(d, side).rows);
    expect(top(right, 'right')).toBeGreaterThan(top(straight, 'right'));
    expect(top(right, 'left')).toBeLessThan(top(straight, 'left'));
  });
});

describe('the handlebar stays with the scooter while the head turns', () => {
  test('looking right slides the bar left', () => {
    expect(Math.max(...drawn(0, 0.3).cols)).toBeLessThan(Math.max(...drawn(0).cols));
  });

  test('at 90° the bar is out of view', () => {
    expect(drawn(0, Math.PI / 2).cols).toEqual([]);
    expect(drawn(0, -Math.PI / 2).cols).toEqual([]);
  });
});
