import { describe, expect, test } from 'vitest';
import { reflectedColour } from './colour';
import { LAMP } from './lighting';

describe('reflectedColour', () => {
  /** The base colour with a typical reflection (40 per unit) added. */
  const lit = (base: readonly [number, number, number], tint: number) => {
    const [r, g, b] = reflectedColour(base, LAMP, tint);
    return { r: base[0] + 40 * r, g: base[1] + 40 * g, b: base[2] + 40 * b };
  };

  test('warm light on blue brick makes it a brighter blue: mostly blue added, no white wash, never violet', () => {
    const { r, g, b } = lit([12, 18, 150], 0.85);
    expect(Math.min(r - 12, g - 18, b - 150)).toBeGreaterThan(0);
    // Mostly more blue: red and green gain little next to it.
    expect(b - 150).toBeGreaterThan(2.5 * (g - 18));
    // Violet is red outgrowing green under the blue: red must not.
    expect(g - 18).toBeGreaterThanOrEqual(r - 12);
  });

  test('on wood it stays warm, only brighter', () => {
    const { r, g, b } = lit([150, 90, 45], 0);
    expect(r).toBeGreaterThan(150);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  test('on a grey wall it stays about neutral, a touch warmer, never cooler', () => {
    const { r, g, b } = lit([190, 192, 190], 0.85);
    expect(r - b).toBeGreaterThan(0);
    expect(g - b).toBeGreaterThan(0);
  });

  test('with none of the surface’s colour, adds about the lamp’s brightness, whatever the colour', () => {
    // Per unit of reflection, the added light weighs about as much as the lamp's own (Rec. 709 luma).
    const luma = ([r, g, b]: readonly number[]) => 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    for (const base of [
      [12, 18, 150],
      [150, 90, 45],
      [190, 192, 190],
    ] as const) {
      expect(luma(reflectedColour(base, LAMP, 0))).toBeCloseTo(luma([LAMP.r, LAMP.g, LAMP.b]), 0);
    }
  });
});
