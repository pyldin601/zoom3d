import { SIP_MS } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { sipPose } from './sip';

test('at rest outside a sip, including before any sip', () => {
  for (const t of [-1, SIP_MS, SIP_MS + 500, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(sipPose(t)).toBe(0);
  }
  expect(sipPose(0)).toBe(0);
});

test('held at the mouth from 350 ms to 1050 ms', () => {
  for (const t of [350, 700, 1050]) {
    expect(sipPose(t)).toBe(1);
  }
});

test('eased: halfway at the middle of each move', () => {
  expect(sipPose(175)).toBeCloseTo(0.5, 2);
  expect(sipPose(1225)).toBeCloseTo(0.5, 2);
});

test('rises steadily, then falls steadily', () => {
  for (let t = 0; t < 350; t += 10) {
    expect(sipPose(t + 10)).toBeGreaterThanOrEqual(sipPose(t));
  }
  for (let t = 1050; t < 1390; t += 10) {
    expect(sipPose(t + 10)).toBeLessThanOrEqual(sipPose(t));
  }
});
