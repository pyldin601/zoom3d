import { describe, expect, test } from 'vitest';
import { createFramebuffer, type Framebuffer } from './framebuffer';
import { renderOwnHandlebar } from './own-handlebar';
import { ownTexel } from './own-held';

function drawn(steer: number): { fb: Framebuffer; cols: number[]; rows: number[] } {
  const fb = createFramebuffer();
  fb.pixels.fill(0);
  renderOwnHandlebar(fb, steer);
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
