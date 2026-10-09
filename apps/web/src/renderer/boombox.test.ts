import { expect, test } from 'vitest';
import { BOOMBOX_LEFT, BOOMBOX_MAP, BOOMBOX_SPRITE, BOOMBOX_TOP } from './boombox';
import { hexToRgb } from './sprites';

test('the boombox is a 16×12 pixel map with every letter coloured', () => {
  expect([BOOMBOX_SPRITE.w, BOOMBOX_SPRITE.h]).toEqual([16, 12]);
  expect(BOOMBOX_MAP.every((row) => row.length === 16)).toBe(true);
  BOOMBOX_MAP.forEach((row, v) => {
    [...row].forEach((ch, u) => {
      expect(BOOMBOX_SPRITE.texels[v * 16 + u] !== 0).toBe(ch !== '.');
    });
  });
});

test('the fist grips the handle on top, centred', () => {
  const hand = ['#f2c29b', '#c98d6a', '#8a5236'].map(hexToRgb);
  const { w, texels } = BOOMBOX_SPRITE;
  const at = [...texels.keys()].filter((i) => hand.includes(texels[i] as number));
  expect(at.every((i) => Math.floor(i / w) < 4)).toBe(true);
  const meanU = at.reduce((a, i) => a + (i % w), 0) / at.length;
  expect(Math.abs(meanU - 7.5)).toBeLessThanOrEqual(1);
});

test("it hangs on the viewer's left, its right edge mirroring the drink's left edge", () => {
  expect(BOOMBOX_LEFT).toBeCloseTo(-1.43);
  expect(BOOMBOX_TOP).toBe(-0.15);
});
