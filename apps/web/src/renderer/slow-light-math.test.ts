import { describe, expect, test } from 'vitest';
import { aberrate, betaOf, type Dir, dopplerAlong, sourceDoppler, terrellTurn } from './slow-light-math';

test('beta clamps at half the speed of light', () => {
  expect(betaOf(6, 6)).toBe(0.5);
  expect(betaOf(3, 12)).toBe(0.25);
  expect(betaOf(0, 12)).toBe(0);
  // Below a hundredth of c is rest: the view stops being recomputed.
  expect(betaOf(0.1, 12)).toBe(0);
});

describe('in three dimensions', () => {
  const unit = (x: number, y: number, z: number): Dir => {
    const l = Math.hypot(x, y, z);
    return { x: x / l, y: y / l, z: z / l };
  };
  const out = (): Dir => ({ x: 0, y: 0, z: 0 });
  const angleTo = (n: Dir, a: number) => Math.acos(n.x * Math.cos(a) + n.y * Math.sin(a));

  test('at rest nothing moves', () => {
    const n = unit(1, 0.3, -0.2);
    expect(aberrate(n, 0.7, 0, out())).toEqual(n);
  });

  test('inverse then forward aberration returns the direction', () => {
    const n = unit(1, -0.4, 0.3);
    const back = aberrate(aberrate(n, 0.5, 0.45, out()), 0.5, -0.45, out());
    expect(back.x).toBeCloseTo(n.x, 9);
    expect(back.y).toBeCloseTo(n.y, 9);
    expect(back.z).toBeCloseTo(n.z, 9);
  });

  test('the direction of motion stays put, and light seen near it came from further off', () => {
    const along = aberrate(unit(Math.cos(0.3), Math.sin(0.3), 0), 0.3, 0.5, out());
    expect(along.x).toBeCloseTo(Math.cos(0.3), 9);
    expect(along.y).toBeCloseTo(Math.sin(0.3), 9);
    const seen = unit(1, 0.2, 0.25);
    expect(angleTo(aberrate(seen, 0, 0.5, out()), 0)).toBeGreaterThan(angleTo(seen, 0));
  });

  test('a straight vertical line off the motion bends', () => {
    const slope = (z: number) => {
      const n = aberrate(unit(1, 0.4, z), 0, 0.5, out());
      return n.y / n.x;
    };
    expect(Math.abs(slope(0) - slope(0.5))).toBeGreaterThan(0.01);
  });

  test('looking straight along the motion stays finite', () => {
    const n = aberrate({ x: 1, y: 0, z: 0 }, 0, 0.5, out());
    expect([n.x, n.y, n.z].every(Number.isFinite)).toBe(true);
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 9);
  });

  test('doppler: one at rest, 1.732 ahead, 0.577 behind, 0.866 side-on at half of c', () => {
    expect(dopplerAlong(unit(1, 0.2, 0.1), 0.4, 0)).toBe(1);
    expect(dopplerAlong({ x: 1, y: 0, z: 0 }, 0, 0.5)).toBeCloseTo(1.732, 3);
    expect(dopplerAlong({ x: -1, y: 0, z: 0 }, 0, 0.5)).toBeCloseTo(0.577, 3);
    expect(dopplerAlong({ x: 0, y: 0, z: 1 }, 0, 0.5)).toBeCloseTo(0.866, 3);
  });
});

describe('a thing’s own motion (D41)', () => {
  test('its Doppler factor is 1 at rest, above 1 coming toward the eye, below going away', () => {
    expect(sourceDoppler(0, 0, 1, 0, 6)).toBe(1);
    expect(sourceDoppler(3, 0, 1, 0, 6)).toBeGreaterThan(1);
    expect(sourceDoppler(-3, 0, 1, 0, 6)).toBeLessThan(1);
    // Toward the eye at β = 0.5: 1 / (γ (1 − β)) = √3.
    expect(sourceDoppler(3, 0, 1, 0, 6)).toBeCloseTo(Math.sqrt(3), 9);
  });

  test('β above the cap gives the cap’s factor', () => {
    expect(sourceDoppler(12, 0, 1, 0, 6)).toBeCloseTo(sourceDoppler(3, 0, 1, 0, 6), 12);
  });

  test('a model crossing the view is turned by asin β, showing its back; head-on it is not turned', () => {
    // Moving along +x, seen from the +y side, at β = 0.5.
    const turn = terrellTurn(3, 0, 0, 1, 6);
    expect(Math.abs(turn)).toBeCloseTo(Math.asin(0.5), 9);
    const backX = -Math.cos(turn);
    const backY = -Math.sin(turn);
    expect(backX * 0 + backY * 1).toBeGreaterThan(0);
    expect(terrellTurn(3, 0, 1, 0, 6)).toBeCloseTo(0, 12);
    expect(terrellTurn(0, 0, 0, 1, 6)).toBe(0);
  });
});
