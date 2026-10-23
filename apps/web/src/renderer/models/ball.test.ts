import { BALL_RADIUS } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { BALL_MODEL, BALL_SHINE, ballPatternAt, createBallRoll, recolourBall, rollBy } from './ball';

// Ball spec §5: a voxel sphere whose pattern rolls (the geometry stays put; the colours turn).
const centreOf = (i: number) => {
  const c = BALL_MODEL.corners;
  const at = (k: number) =>
    ((c[i * 12 + k] ?? 0) + (c[i * 12 + 3 + k] ?? 0) + (c[i * 12 + 6 + k] ?? 0) + (c[i * 12 + 9 + k] ?? 0)) / 4;
  return { x: at(0), y: at(1), z: at(2) - BALL_RADIUS };
};
const faces = [...Array(BALL_MODEL.faceCount).keys()];

describe('the ball model', () => {
  test('is a sphere of the ball radius on the floor', () => {
    expect(BALL_MODEL.faceCount).toBeGreaterThan(100);
    for (const i of faces) {
      const { x, y, z } = centreOf(i);
      expect(Math.hypot(x, y, z)).toBeGreaterThan(BALL_RADIUS - 0.05);
      expect(Math.hypot(x, y, z)).toBeLessThan(BALL_RADIUS + 0.05);
    }
    expect(BALL_MODEL.shadowRadius).toBeCloseTo(BALL_RADIUS);
  });

  test('shows both its colours', () => {
    expect(new Set(BALL_MODEL.base).size).toBe(2);
  });
});

describe('rolling', () => {
  test('no roll gives the base pattern', () => {
    const before = [...BALL_MODEL.base];
    recolourBall(BALL_MODEL, createBallRoll());
    expect([...BALL_MODEL.base]).toEqual(before);
  });

  test('a half turn along x shows each face what was at (−x, y, −z)', () => {
    const roll = createBallRoll();
    rollBy(roll, Math.PI * BALL_RADIUS, 0);
    recolourBall(BALL_MODEL, roll);
    for (const i of faces) {
      const { x, y, z } = centreOf(i);
      const d = Math.hypot(x, y, z);
      expect(BALL_MODEL.base[i]).toBe(ballPatternAt(-x / d, y / d, -z / d));
    }
  });

  test('a full turn brings the pattern back', () => {
    const before = [...BALL_MODEL.base];
    const roll = createBallRoll();
    for (let i = 0; i < 100; i++) {
      rollBy(roll, (2 * Math.PI * BALL_RADIUS) / 100, (2 * Math.PI * BALL_RADIUS) / 100);
    }
    rollBy(roll, -2 * Math.PI * BALL_RADIUS, -2 * Math.PI * BALL_RADIUS);
    recolourBall(BALL_MODEL, roll);
    expect([...BALL_MODEL.base]).toEqual(before);
  });

  test('recolouring writes into the model in place', () => {
    const { colors, base } = BALL_MODEL;
    recolourBall(BALL_MODEL, createBallRoll());
    expect(BALL_MODEL.colors).toBe(colors);
    expect(BALL_MODEL.base).toBe(base);
  });

  test('its dark patches shine and its white ones do not, as they roll', () => {
    const roll = createBallRoll();
    rollBy(roll, 0.13, -0.07);
    recolourBall(BALL_MODEL, roll);
    const white = Math.max(...BALL_MODEL.base);
    for (const i of faces) {
      expect(BALL_MODEL.shine[i]).toBe(BALL_MODEL.base[i] === white ? 0 : BALL_SHINE);
    }
    recolourBall(BALL_MODEL, createBallRoll());
  });
});
