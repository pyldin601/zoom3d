import type { BallMood } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { ballShake } from './ball-shake';

// Living ball spec §4: the tremble is small and only drawn.
const out = { x: 0, y: 0 };
const samples = (mood: BallMood) =>
  Array.from({ length: 200 }, (_, i) => {
    ballShake(mood, i * 7, out);
    return { ...out };
  });

describe('ballShake', () => {
  test.each<BallMood>(['asleep', 'wandering', 'approaching', 'playing', 'following'])('%s does not shake', (mood) => {
    expect(samples(mood).every((s) => s.x === 0 && s.y === 0)).toBe(true);
  });

  test('a tremble stays within 0.03 tiles on each axis, on both', () => {
    const tremble = samples('scared');
    for (const axis of ['x', 'y'] as const) {
      const biggest = Math.max(...tremble.map((s) => Math.abs(s[axis])));
      expect(biggest).toBeGreaterThan(0.02);
      expect(biggest).toBeLessThanOrEqual(0.03);
    }
  });
});
