import { describe, expect, test } from 'vitest';
import { createView, setView } from './camera';
import { DEFAULT_FOV, rgb } from './framebuffer';
import { nextRippleDown, openingEdge, shimmerAndRim, startRippleDown, windowRipple } from './portal-window';
import { portalHall } from './test-portals';

const red = (c: number) => c & 0xff;
const green = (c: number) => (c >>> 8) & 0xff;

describe('shimmerAndRim', () => {
  test('the rim is brightest at the opening’s edge and fades inward', () => {
    const black = rgb(0, 0, 0);
    const atEdge = shimmerAndRim(black, 1, 0, 0);
    const inside = shimmerAndRim(black, 1, 0, 10);
    expect(red(atEdge)).toBeGreaterThan(red(inside));
  });

  test('the shimmer pulls a grey pixel toward pink, more at the pulse’s peak', () => {
    const grey = rgb(100, 100, 100);
    const low = shimmerAndRim(grey, 0.6, 0.5, 100);
    const high = shimmerAndRim(grey, 1, 0.5, 100);
    expect(red(high) - green(high)).toBeGreaterThan(red(low) - green(low));
    expect(red(low)).toBeGreaterThan(green(low));
  });

  test('a bright pixel at the edge clamps rather than wrapping', () => {
    const lit = shimmerAndRim(rgb(250, 250, 250), 1, 1, 0);
    expect(red(lit)).toBe(255);
    expect(lit >>> 24).toBe(0xff);
  });
});

describe('windowRipple', () => {
  test('the ripple is the same wave at any frame width', () => {
    expect(windowRipple(64, 128, 640, 0)).toBeCloseTo(windowRipple(32, 64, 320, 0), 9);
  });
});

describe('the ripple down a column', () => {
  test('follows windowRipple row by row, down the tallest frame', () => {
    startRippleDown(5, 300, 640, 12.3);
    for (let row = 5; row < 1080; row++) {
      expect(nextRippleDown()).toBeCloseTo(windowRipple(row, 300, 640, 12.3), 9);
    }
  });
});

describe('openingEdge', () => {
  test('a column through the middle of the opening is half a tile from either edge', () => {
    // Eye 1.5 tiles in front of doorway A (portalHall), looking straight through its centre.
    const view = setView(
      createView(),
      { width: 320, height: 200, fov: DEFAULT_FOV },
      { x: 2.5, y: 2.0, angle: Math.PI / 2 }
    );
    const doorwayA = portalHall().portals.list.at(0);
    if (!doorwayA) {
      throw new Error('portalHall has doorway A');
    }
    const edge = openingEdge(view, doorwayA, 159.5, 1.5, 320);
    expect(edge).toBeCloseTo(0.5 * (view.proj / 1.5), 1);
  });
});
