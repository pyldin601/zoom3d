import { describe, expect, test } from 'vitest';
import { portalPulse } from './portal-pulse';

describe('portalPulse', () => {
  test('swings between 1 − depth and 1', () => {
    const samples = Array.from({ length: 200 }, (_, i) => portalPulse(i / 100));
    expect(Math.min(...samples)).toBeCloseTo(0.6, 2);
    expect(Math.max(...samples)).toBeCloseTo(1, 2);
  });

  test('repeats 0.8 times a second', () => {
    expect(portalPulse(0.3)).toBeCloseTo(portalPulse(0.3 + 1 / 0.8), 9);
  });

  test('is at its midpoint at time 0', () => {
    expect(portalPulse(0)).toBeCloseTo(0.8, 9);
  });
});
