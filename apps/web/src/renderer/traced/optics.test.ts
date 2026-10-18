import { describe, expect, test } from 'vitest';
import { blobWeight, type ConeSpread, fresnel, spreadCone } from './optics';
import { TRACED_MATERIALS, type TracedMaterial } from './world';

const ROUND_THING_RADIUS = 0.35;

describe('fresnel', () => {
  test.each(TRACED_MATERIALS)('face-on, a surface reflects its f0 (roughness $roughness)', (material) => {
    expect(fresnel(1, material)).toBe(material.f0);
  });

  test.each(TRACED_MATERIALS)(
    'at a graze, a surface reflects what roughness leaves (roughness $roughness)',
    (material) => {
      expect(fresnel(0, material)).toBe(Math.max(1 - material.roughness, material.f0));
    }
  );

  test('a rough surface never turns into a mirror at a graze', () => {
    const matte: TracedMaterial = { f0: 0.04, roughness: 1, tint: 0 };
    expect(fresnel(0, matte)).toBe(matte.f0);
  });

  test.each(TRACED_MATERIALS)('it never rises as the view turns face-on (roughness $roughness)', (material) => {
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 1000; step++) {
      const reflected = fresnel(step / 1000, material);
      expect(reflected).toBeLessThanOrEqual(previous);
      previous = reflected;
    }
  });

  test('a cosine outside 0..1 counts as the nearest end', () => {
    const stone: TracedMaterial = { f0: 0.04, roughness: 0.85, tint: 0.6 };
    expect(fresnel(-0.5, stone)).toBe(fresnel(0, stone));
    expect(fresnel(2, stone)).toBe(fresnel(1, stone));
  });
});

describe('blobWeight', () => {
  test('a sharp round thing straight ahead is fully there', () => {
    expect(blobWeight(0, 0, ROUND_THING_RADIUS, 0, 0)).toBe(1);
  });

  test('it fades as the cone passes to the side', () => {
    let previous = blobWeight(0, 0, ROUND_THING_RADIUS, 0.1, 0.1);
    for (let across = 0.02; across < 0.5; across += 0.02) {
      const weight = blobWeight(across, 0, ROUND_THING_RADIUS, 0.1, 0.1);
      expect(weight).toBeLessThan(previous);
      previous = weight;
    }
  });

  test('it fades as the cone passes above or below', () => {
    let previous = blobWeight(0, 0, ROUND_THING_RADIUS, 0.1, 0.1);
    for (let up = 0.02; up < 0.5; up += 0.02) {
      const weight = blobWeight(0, up, ROUND_THING_RADIUS, 0.1, 0.1);
      expect(weight).toBeLessThan(previous);
      previous = weight;
    }
  });

  test('it is nothing past the reach of the blob', () => {
    // A sharp thing's blob has deviation radius / 2 = 0.175, and reaches sqrt(18) deviations: 0.742 tiles.
    expect(blobWeight(0.74, 0, ROUND_THING_RADIUS, 0, 0)).toBeGreaterThan(0);
    expect(blobWeight(0.75, 0, ROUND_THING_RADIUS, 0, 0)).toBe(0);
    expect(blobWeight(0, 0.74, ROUND_THING_RADIUS, 0, 0)).toBeGreaterThan(0);
    expect(blobWeight(0, 0.75, ROUND_THING_RADIUS, 0, 0)).toBe(0);
  });

  test('a wider cone spreads the same light thinner', () => {
    expect(blobWeight(0, 0, ROUND_THING_RADIUS, 0.5, 0.5)).toBeLessThan(blobWeight(0, 0, ROUND_THING_RADIUS, 0.3, 0.3));
  });

  test('a cone stretched along one axis spreads the blob along it', () => {
    const stretchedAcross = blobWeight(0.3, 0, ROUND_THING_RADIUS, 0.5, 0.1);
    const stretchedUp = blobWeight(0.3, 0, ROUND_THING_RADIUS, 0.1, 0.5);
    expect(stretchedAcross).toBeGreaterThan(stretchedUp);
  });

  /** The weight summed over a fine grid, in squared tiles. */
  function weightIntegral(radius: number, spreadAcross: number, spreadUp: number): number {
    const step = 0.01;
    const extentAcross = 4.5 * Math.sqrt(radius ** 2 / 4 + spreadAcross ** 2);
    const extentUp = 4.5 * Math.sqrt(radius ** 2 / 4 + spreadUp ** 2);
    let sum = 0;
    for (let across = -extentAcross; across <= extentAcross; across += step) {
      for (let up = -extentUp; up <= extentUp; up += step) {
        sum += blobWeight(across, up, radius, spreadAcross, spreadUp) * step * step;
      }
    }
    return sum;
  }

  test.each([
    [0.35, 0.35, 0.35],
    [0.35, 0.6, 0.6],
    [0.35, 0.4, 1],
    [0.18, 0.18, 0.5],
  ])('a blob of radius %f and spreads %f, %f is as bright overall as the disc (pi r squared)', (radius, across, up) => {
    const disc = Math.PI * radius * radius;
    expect(weightIntegral(radius, across, up)).toBeGreaterThan(disc * 0.95);
    expect(weightIntegral(radius, across, up)).toBeLessThan(disc * 1.05);
  });

  test('it never exceeds 1, however narrow the cone', () => {
    for (const spread of [0, 0.001, 0.01, 0.1]) {
      expect(blobWeight(0, 0, 0.18, spread, spread)).toBeLessThanOrEqual(1);
    }
  });
});

describe('spreadCone, by mirror geometry', () => {
  const CONE = 0.4;
  const SLANTS = [1, 0.7, 0.3, 0.1];

  test.each(SLANTS)('off the floor it keeps its width up the view and narrows across it by the slant (%f)', (slant) => {
    const spread: ConeSpread = { across: 0, up: 0 };
    spreadCone(CONE, slant, 'up', spread);
    expect(spread.up).toBe(CONE);
    expect(spread.across).toBeCloseTo(CONE * slant, 12);
  });

  test.each(SLANTS)('off a wall it keeps its width across the view and narrows up it by the slant (%f)', (slant) => {
    const spread: ConeSpread = { across: 0, up: 0 };
    spreadCone(CONE, slant, 'across', spread);
    expect(spread.across).toBe(CONE);
    expect(spread.up).toBeCloseTo(CONE * slant, 12);
  });
});
