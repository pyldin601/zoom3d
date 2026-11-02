import type { BallMood } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { ballShake } from './ball-shake';

// Living ball spec §4: the wiggle and tremble are small and only drawn.
const out = { x: 0, y: 0 };
const samples = (mood: BallMood, heading = 0) =>
  Array.from({ length: 200 }, (_, i) => {
    ballShake(mood, heading, i * 7, out);
    return { ...out };
  });

describe('ballShake', () => {
  test.each<BallMood>(['asleep', 'wandering', 'approaching', 'following'])('%s does not shake', (mood) => {
    expect(samples(mood).every((s) => s.x === 0 && s.y === 0)).toBe(true);
  });

  test('a wiggle stays within 0.05 tiles, across the way it faces', () => {
    const wiggle = samples('wiggling');
    expect(Math.max(...wiggle.map((s) => Math.abs(s.y)))).toBeGreaterThan(0.04);
    expect(Math.max(...wiggle.map((s) => Math.abs(s.y)))).toBeLessThanOrEqual(0.05);
    expect(Math.max(...wiggle.map((s) => Math.abs(s.x)))).toBeLessThan(1e-9);
  });

  test('a wiggle turns with the heading', () => {
    const wiggle = samples('wiggling', Math.PI / 2);
    expect(Math.max(...wiggle.map((s) => Math.abs(s.x)))).toBeGreaterThan(0.04);
    expect(Math.max(...wiggle.map((s) => Math.abs(s.y)))).toBeLessThan(1e-9);
  });

  test('a tremble stays within 0.03 tiles on each axis, on both', () => {
    const tremble = samples('scared');
    for (const axis of ['x', 'y'] as const) {
      const biggest = Math.max(...tremble.map((s) => Math.abs(s[axis])));
      expect(biggest).toBeGreaterThan(0.02);
      expect(biggest).toBeLessThanOrEqual(0.03);
    }
  });

  test('a tremble is much quicker than a wiggle', () => {
    const crossings = (values: number[]) => values.filter((v, i) => i > 0 && v * (values.at(i - 1) ?? 0) < 0).length;
    expect(crossings(samples('scared').map((s) => s.x))).toBeGreaterThan(
      4 * crossings(samples('wiggling').map((s) => s.y))
    );
  });
});
