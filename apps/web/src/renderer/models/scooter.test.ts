import { expect, test } from 'vitest';
import { RIDDEN_SCOOTER_MODEL, SCOOTER_MODEL } from './scooter';

// Scooter headlight spec: the stem lamp glows only while ridden.
const shiningFaces = (shine: Uint32Array) => shine.filter((c) => c !== 0).length;

test('the lamp glows on a ridden scooter and is dark on a parked one', () => {
  expect(shiningFaces(RIDDEN_SCOOTER_MODEL.shine)).toBeGreaterThan(0);
  expect(shiningFaces(SCOOTER_MODEL.shine)).toBe(0);
});

test('parked and ridden, the scooter has the same shape', () => {
  expect(SCOOTER_MODEL.corners).toEqual(RIDDEN_SCOOTER_MODEL.corners);
});
