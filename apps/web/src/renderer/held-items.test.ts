import { expect, test } from 'vitest';
import { HELD_SPRITES } from './held-items';
import { hexToRgb } from './sprites';

test('every item has a texture of its pixel map size', () => {
  const sizes = Object.fromEntries(Object.entries(HELD_SPRITES).map(([k, s]) => [k, [s.w, s.h, s.texels.length]]));
  expect(sizes).toEqual({ beer: [13, 10, 130], coffee: [13, 9, 117], wine: [7, 10, 70] });
});

test('transparent pixels are 0 and opaque ones carry full alpha', () => {
  const { w, texels } = HELD_SPRITES.beer;
  expect(texels[0]).toBe(0);
  expect(texels[9 * w + 12]).toBe(hexToRgb('#cfe3ea'));
});
