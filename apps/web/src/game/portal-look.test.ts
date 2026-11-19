import { photonPortals } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { portalHall } from '../renderer/test-portals';
import { shownPortals } from './portal-look';

describe('shownPortals', () => {
  const classic = portalHall().portals;
  const photon = photonPortals(classic);

  test('shows no portals while they are off, whatever the look', () => {
    expect(shownPortals(null, photon, 'realistic', true)).toBeNull();
  });

  test('shows the classic set when classic is chosen', () => {
    expect(shownPortals(classic, photon, 'classic', true)).toBe(classic);
  });

  test('keeps the classic set until the realistic lighting is baked', () => {
    expect(shownPortals(classic, photon, 'realistic', false)).toBe(classic);
  });

  test('shows the photon set once realistic is chosen and baked', () => {
    expect(shownPortals(classic, photon, 'realistic', true)).toBe(photon);
  });
});
