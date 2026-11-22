import { expect, test } from 'vitest';
import { betaOf, dopplerFactor, type Rgb, SOURCE_FOV, sourceAngle, tintOf } from './slow-light-math';

const DEG = Math.PI / 180;

test('beta clamps at half the speed of light', () => {
  expect(betaOf(6, 6)).toBe(0.5);
  expect(betaOf(3, 12)).toBe(0.25);
  expect(betaOf(0, 12)).toBe(0);
});

test('at rest the source angle is the apparent one', () => {
  for (let a = -1; a <= 1; a += 0.25) {
    expect(sourceAngle(a, 0.7, 0)).toBeCloseTo(a, 9);
  }
});

test('moving forward crowds the view: light seen off to the side came from further out', () => {
  expect(Math.abs(sourceAngle(0.5, 0, 0.5))).toBeGreaterThan(0.5);
  expect(sourceAngle(-0.5, 0, 0.5)).toBeLessThan(-0.5);
  expect(sourceAngle(0, 0, 0.5)).toBeCloseTo(0, 9);
});

test('aberration is symmetric about the motion', () => {
  const m = 0.6;
  for (const x of [0.1, 0.4, 0.9]) {
    expect(sourceAngle(m + x, m, 0.4) - m).toBeCloseTo(-(sourceAngle(m - x, m, 0.4) - m), 9);
  }
});

test('stays finite and inside the source view at the cap, whichever way the motion points', () => {
  for (let motion = 0; motion < 360; motion++) {
    for (const edge of [-33, 33, -25, 25]) {
      const a = sourceAngle(edge * DEG, motion * DEG, 0.5);
      expect(Number.isFinite(a)).toBe(true);
      expect(Math.abs(a)).toBeLessThanOrEqual(SOURCE_FOV / 2);
    }
  }
});

test('doppler is one at rest, above one ahead and below behind', () => {
  expect(dopplerFactor(0, 0, 0)).toBe(1);
  expect(dopplerFactor(0, 0, 0.5)).toBeCloseTo(1.732, 3);
  expect(dopplerFactor(Math.PI, 0, 0.5)).toBeCloseTo(0.577, 3);
});

test('the tint is the identity at one, blue ahead, red behind, and clamped', () => {
  const out: Rgb = { r: 0, g: 0, b: 0 };
  expect({ ...tintOf(1, out) }).toEqual({ r: 1, g: 1, b: 1 });
  const ahead = { ...tintOf(1.7, out) };
  expect(ahead.b).toBeGreaterThan(ahead.r);
  const behind = { ...tintOf(0.58, out) };
  expect(behind.r).toBeGreaterThan(behind.b);
  for (const d of [100, 0.01]) {
    const c = tintOf(d, out);
    for (const gain of [c.r, c.g, c.b]) {
      expect(gain).toBeGreaterThanOrEqual(0.35);
      expect(gain).toBeLessThanOrEqual(1.8);
    }
  }
});
