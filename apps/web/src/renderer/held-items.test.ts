import { expect, test } from 'vitest';
import { HELD_SPRITES } from './held-items';
import { hexToRgb } from './sprites';

test('every item has a texture of its pixel map size', () => {
  const sizes = Object.fromEntries(Object.entries(HELD_SPRITES).map(([k, s]) => [k, [s.w, s.h, s.texels.length]]));
  expect(sizes).toEqual({ beer: [10, 10, 100], coffee: [10, 9, 90], wine: [7, 10, 70] });
});

test('transparent pixels are 0 and opaque ones carry full alpha', () => {
  const { w, texels } = HELD_SPRITES.beer;
  expect(texels[0]).toBe(0);
  expect(texels[9 * w]).toBe(hexToRgb('#cfe3ea'));
});

test('drinks are held from the outside: the hand is on the far side from the disc, the drink next to it', () => {
  const hand = ['#f2c29b', '#c98d6a', '#8a5236'].map(hexToRgb);
  for (const item of ['beer', 'coffee', 'wine'] as const) {
    const { w, texels } = HELD_SPRITES[item];
    const us = [...texels.keys()].filter((i) => hand.includes(texels[i] as number)).map((i) => i % w);
    expect(us.reduce((a, b) => a + b, 0) / us.length).toBeGreaterThan((w - 1) / 2);
  }
});

test('a mug is held in a small fist: at most 4 texels wide and 5 tall', () => {
  const hand = ['#f2c29b', '#c98d6a', '#8a5236'].map(hexToRgb);
  for (const item of ['beer', 'coffee'] as const) {
    const { w, texels } = HELD_SPRITES[item];
    const cells = [...texels.keys()].filter((i) => hand.includes(texels[i] as number));
    const us = cells.map((i) => i % w);
    const vs = cells.map((i) => Math.floor(i / w));
    expect(Math.max(...us) - Math.min(...us) + 1, item).toBeLessThanOrEqual(4);
    expect(Math.max(...vs) - Math.min(...vs) + 1, item).toBeLessThanOrEqual(5);
  }
});
