import { expect, test } from 'vitest';
import { ringWidth, rmsLevel } from './mic-level';

test('silence is level 0', () => {
  expect(rmsLevel(new Float32Array(512))).toBe(0);
});

test('a full-scale square wave is level 1', () => {
  const samples = new Float32Array(512).map((_, i) => (i % 2 ? 1 : -1));
  expect(rmsLevel(samples)).toBe(1);
});

test('quiet speech scales up by 4', () => {
  const samples = new Float32Array(512).fill(0.1);
  expect(rmsLevel(samples)).toBeCloseTo(0.4, 5);
});

test('the ring is 0–6 px wide', () => {
  expect(ringWidth(0)).toBe(0);
  expect(ringWidth(0.5)).toBe(3);
  expect(ringWidth(1)).toBe(6);
  expect(ringWidth(2)).toBe(6);
  expect(ringWidth(-1)).toBe(0);
});
