import { RIDE_SPEED } from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createScooterSound, motorLevel, motorToneHz, pwmLevel, SCOOTER_MASTER, wheelLevel } from './scooter-sound';

// Scooter sound spec §4: the owner's tuned PWM whiss, motor tone, wheels and bumps.
let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});
type Osc = FakeNode & { type: string; frequency: FakeParam; stoppedAt: number | null };
type Filter = FakeNode & { frequency: FakeParam };
type Gain = FakeNode & { gain: FakeParam };
const oscillators = () => ctx.byKind('oscillator') as unknown as Osc[];
const filtersAt = (hz: number) => (ctx.byKind('biquad') as unknown as Filter[]).filter((f) => f.frequency.value === hz);

describe('levels by load', () => {
  test('the whiss: loud speeding up, softer holding speed, almost gone coasting', () => {
    expect(pwmLevel('pulling', 3)).toBe(0.35);
    expect(pwmLevel('cruising', RIDE_SPEED)).toBe(0.18);
    expect(pwmLevel('coasting', 1)).toBe(0.02);
    expect(pwmLevel('coasting', 0.15)).toBeCloseTo(0.01);
    expect(pwmLevel('coasting', 0)).toBe(0);
  });

  test('the motor tone climbs to 157 Hz at full speed and never drops under 30 Hz', () => {
    expect(motorToneHz(RIDE_SPEED)).toBe(157);
    expect(motorToneHz(3)).toBe(78.5);
    expect(motorToneHz(0)).toBe(30);
  });

  test('the motor tone is quiet: 0.03, 0.02, 0.01', () => {
    expect(motorLevel('pulling', 3)).toBe(0.03);
    expect(motorLevel('cruising', RIDE_SPEED)).toBe(0.02);
    expect(motorLevel('coasting', 1)).toBe(0.01);
  });

  test('the wheels are barely there and follow speed', () => {
    expect(wheelLevel(RIDE_SPEED)).toBeCloseTo(0.12);
    expect(wheelLevel(3)).toBeCloseTo(0.12 * 0.5 ** 1.2);
    expect(wheelLevel(0)).toBe(0);
  });

  test('the loudest layer sits at least 12 dB under a voice', () => {
    expect(20 * Math.log10(SCOOTER_MASTER * 0.35)).toBeLessThanOrEqual(-12);
  });
});

describe('createScooterSound', () => {
  test('the whiss stays at 7800 Hz whatever the speed', () => {
    const s = createScooterSound(asAudioContext(ctx));
    s.set(1, 'pulling', 1 / 60);
    s.set(6, 'cruising', 1 / 60);
    const whiss = oscillators().find((o) => o.frequency.value === 7800);
    expect(whiss).toBeDefined();
    expect(whiss?.frequency.targets.every(([hz]) => hz === 7800)).toBe(true);
  });

  test('the motor tone glides to its pitch for the speed', () => {
    createScooterSound(asAudioContext(ctx)).set(RIDE_SPEED, 'pulling', 1 / 60);
    const triangle = oscillators().find((o) => o.type === 'triangle');
    expect(triangle?.frequency.targets.at(-1)?.[0]).toBe(157);
  });

  test('a floor seam ticks once per tile travelled', () => {
    const s = createScooterSound(asAudioContext(ctx));
    for (let i = 0; i < 62; i++) {
      s.set(3, 'coasting', 1 / 60);
    }
    expect(filtersAt(3200)).toHaveLength(3);
  });

  test('no seam ticks below 0.3 tiles/s', () => {
    const s = createScooterSound(asAudioContext(ctx));
    for (let i = 0; i < 600; i++) {
      s.set(0.2, 'coasting', 1 / 60);
    }
    expect(filtersAt(3200)).toHaveLength(0);
  });

  test('a bump is a thud sweeping 136 to 85 Hz and a rattle at 1500 Hz, with no ring', () => {
    const s = createScooterSound(asAudioContext(ctx));
    const before = oscillators().length;
    s.bump(1);
    const added = oscillators().slice(before);
    expect(added).toHaveLength(1);
    const events = added.at(0)?.frequency.events ?? [];
    expect(events.at(0)?.slice(0, 2)).toEqual(['set', 136]);
    expect(events.at(-1)?.slice(0, 2)).toEqual(['exponential', 85]);
    expect(filtersAt(1500)).toHaveLength(1);
  });

  test('stopping fades every layer out before the oscillators stop', () => {
    const s = createScooterSound(asAudioContext(ctx));
    s.set(RIDE_SPEED, 'pulling', 1 / 60);
    s.dispose();
    const layers = (ctx.byKind('gain') as unknown as Gain[]).filter((g) => g.gain.targets.length > 0);
    const faded = layers.filter((g) => g.gain.targets.at(-1)?.[0] === 0);
    expect(faded.length).toBeGreaterThanOrEqual(3);
    for (const o of oscillators()) {
      expect(o.stoppedAt).toBeGreaterThan(ctx.currentTime);
    }
  });
});
