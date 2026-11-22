import { expect, test } from 'vitest';
import {
  DOPPLER_STEPS,
  dopplerIndex,
  linearToSrgbByte,
  SHIFT_MATRICES,
  SRGB_TO_LINEAR,
  shiftMatrix,
  toneCurve,
} from './spectrum';

/** M(d) · rgb. */
function shifted(d: number, r: number, g: number, b: number): [number, number, number] {
  const m = shiftMatrix(d, new Float32Array(9));
  const at = (i: number) => m.at(i) ?? 0;
  return [at(0) * r + at(1) * g + at(2) * b, at(3) * r + at(4) * g + at(5) * b, at(6) * r + at(7) * g + at(8) * b];
}
const sum = (c: number[]) => c.reduce((a, b) => a + b, 0);

test('the matrix is the identity at rest', () => {
  const m = shiftMatrix(1, new Float32Array(9));
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => {
    expect(m.at(i)).toBeCloseTo(v, 5);
  });
});

test('grey brightens ahead and darkens behind', () => {
  expect(sum(shifted(1.5, 1, 1, 1))).toBeGreaterThan(3);
  expect(sum(shifted(0.6, 1, 1, 1))).toBeLessThan(0.5);
});

test('ahead a pure blue source still shows, from its infrared', () => {
  expect(sum(shifted(1.5, 0, 0, 1))).toBeGreaterThan(0.3);
});

test('beside, a green source slides toward red', () => {
  const [r] = shifted(0.87, 0, 1, 0);
  expect(r).toBeGreaterThan(0.1);
});

test('the tone curve is the identity to 0.8, rises, and stays below 1', () => {
  expect(toneCurve(0.5)).toBe(0.5);
  expect(toneCurve(0.8)).toBeCloseTo(0.8, 9);
  expect(toneCurve(1)).toBeGreaterThan(0.8);
  expect(toneCurve(3)).toBeGreaterThan(toneCurve(1));
  expect(toneCurve(3)).toBeLessThan(1);
});

test('dopplerIndex clamps outside the table', () => {
  expect(dopplerIndex(0.01)).toBe(0);
  expect(dopplerIndex(100)).toBe(DOPPLER_STEPS - 1);
  expect(dopplerIndex(Number.NaN)).toBe(dopplerIndex(1));
});

test('the table holds exactly the identity at D = 1 and finite numbers everywhere', () => {
  const rest = dopplerIndex(1) * 9;
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => {
    expect(SHIFT_MATRICES.at(rest + i)).toBeCloseTo(v, 6);
  });
  expect(SHIFT_MATRICES.every(Number.isFinite)).toBe(true);
});

test('linear to sRGB round-trips bytes at rest, below the shoulder', () => {
  for (let byte = 0; byte < 256; byte++) {
    const linear = SRGB_TO_LINEAR.at(byte) ?? 0;
    if (linear <= 0.8) {
      expect(Math.abs(linearToSrgbByte(linear) - byte)).toBeLessThanOrEqual(1);
    }
  }
  expect(linearToSrgbByte(-1)).toBe(0);
  expect(linearToSrgbByte(50)).toBeLessThanOrEqual(255);
});
