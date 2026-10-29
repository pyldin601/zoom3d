import { describe, expect, test } from 'vitest';
import { countdownText, sequenceAt, sequenceTimes } from './sequence';

describe('sequenceAt first_on', () => {
  test('counts down 3, 2, 1 a second each, in the light', () => {
    expect(sequenceAt('first_on', 0)).toEqual({ countdown: 3, dark: false, ended: false });
    expect(sequenceAt('first_on', 1999).countdown).toBe(2);
    expect(sequenceAt('first_on', 2999).countdown).toBe(1);
  });

  test('is dark without a countdown from 3000 until 7000', () => {
    expect(sequenceAt('first_on', 3000)).toEqual({ countdown: null, dark: true, ended: false });
    expect(sequenceAt('first_on', 6999).dark).toBe(true);
  });

  test('ends at 7000 with the lights back', () => {
    expect(sequenceAt('first_on', 7000)).toEqual({ countdown: null, dark: false, ended: true });
  });
});

describe('sequenceAt on and off', () => {
  test('are dark from the press until 1000', () => {
    expect(sequenceAt('on', 0).dark).toBe(true);
    expect(sequenceAt('off', 999)).toEqual({ countdown: null, dark: true, ended: false });
  });

  test('end at 1000', () => {
    expect(sequenceAt('on', 1000)).toEqual({ countdown: null, dark: false, ended: true });
  });
});

describe('sequenceTimes', () => {
  test('puts the bend after the countdown and the dark', () => {
    expect(sequenceTimes('first_on')).toEqual({ darkAtMs: 3000, bendAtMs: 5000, lightsAtMs: 7000, endMs: 7000 });
    expect(sequenceTimes('off').bendAtMs).toBe(500);
    expect(sequenceTimes('on')).toEqual({ darkAtMs: 0, bendAtMs: 1000, lightsAtMs: 1000, endMs: 1000 });
  });
});

test('countdownText reads the number in the copy', () => {
  expect(countdownText(3)).toBe('Portals will enable in 3…');
  expect(countdownText(1)).toBe('Portals will enable in 1…');
});
