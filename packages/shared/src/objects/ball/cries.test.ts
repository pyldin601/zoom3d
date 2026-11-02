import { describe, expect, test } from 'vitest';
import { BALL_CRIES } from './cries';

// Living ball spec §5: one to five FM sounds for each emotion, as plain data.
describe('BALL_CRIES', () => {
  test.each(Object.entries(BALL_CRIES))('%s has one to five sounds', (_cry, sounds) => {
    expect(sounds.length).toBeGreaterThanOrEqual(1);
    expect(sounds.length).toBeLessThanOrEqual(5);
  });

  test.each(Object.entries(BALL_CRIES))('every sound of %s can be played', (_cry, sounds) => {
    for (const s of sounds) {
      expect(s.durationS).toBeGreaterThan(0);
      expect(s.startHz).toBeGreaterThan(0);
      expect(s.endHz).toBeGreaterThan(0);
      expect(s.ratio).toBeGreaterThan(0);
      expect(s.depth).toBeGreaterThanOrEqual(0);
      expect(s.peak).toBeGreaterThan(0);
      expect(s.peak).toBeLessThanOrEqual(1);
    }
  });

  test.each(Object.entries(BALL_CRIES))('the sounds of %s all differ', (_cry, sounds) => {
    expect(new Set(sounds.map((s) => JSON.stringify(s))).size).toBe(sounds.length);
  });
});
