import { RIDE_SPEED } from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createScooterSound, magnetHz, pwmLevel, SCOOTER_MASTER, wheelLevel, whineLevel } from './scooter-sound';

// Scooter sound spec §4: the owner's tuned PWM whiss, magnetic motor whine, wheels and bumps.
let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});
type Osc = FakeNode & { type: string; frequency: FakeParam; stoppedAt: number | null };
type Filter = FakeNode & { frequency: FakeParam };
type Gain = FakeNode & { gain: FakeParam };
type Peaking = Filter & { type: string; gain: FakeParam };
const DRIFT_CENTS = 6;
/** The gain that carries the drift's cents to every whine tone's detune. */
const driftGain = () => (ctx.byKind('gain') as unknown as Gain[]).find((g) => g.gain.value === DRIFT_CENTS);
/** The whine's tones, which all drift: the oscillators whose detune the drift drives. */
const whineTones = () =>
  oscillators().filter((o) => driftGain()?.connections.includes((o as unknown as { detune: FakeNode }).detune));
const whineTonesHz = () =>
  whineTones()
    .map((o) => o.frequency.value)
    .sort((a, b) => a - b);
const oscillators = () => ctx.byKind('oscillator') as unknown as Osc[];
/** Band-pass filters at `hz`: the seam's and the rattle's (the housing at 1500 Hz is a peaking one). */
const filtersAt = (hz: number) =>
  (ctx.byKind('biquad') as unknown as (Filter & { type: string })[]).filter(
    (f) => f.type === 'bandpass' && f.frequency.value === hz
  );

describe('levels by load', () => {
  test('the whiss: loud speeding up, softer holding speed, almost gone coasting', () => {
    expect(pwmLevel('pulling', 3)).toBe(0.35);
    expect(pwmLevel('cruising', RIDE_SPEED)).toBe(0.18);
    expect(pwmLevel('coasting', 1)).toBe(0.02);
    expect(pwmLevel('coasting', 0.15)).toBeCloseTo(0.01);
    expect(pwmLevel('coasting', 0)).toBe(0);
  });

  test('the whine follows the motor current: loud speeding up, softer holding speed, almost gone coasting', () => {
    expect(whineLevel('pulling', 3)).toBe(0.1);
    expect(whineLevel('cruising', RIDE_SPEED)).toBe(0.05);
    expect(whineLevel('coasting', 1)).toBe(0.008);
    expect(whineLevel('pulling', 0.15)).toBeCloseTo(0.05);
    expect(whineLevel('pulling', 0)).toBe(0);
  });

  test('the magnets pass at 210 Hz at full speed, in step with the wheel', () => {
    expect(magnetHz(RIDE_SPEED)).toBe(210);
    expect(magnetHz(-RIDE_SPEED / 2)).toBe(105);
    expect(magnetHz(0)).toBe(0);
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

  test('the whine is four magnetic tones: ×1, ×2, the slot tone at ×2.22 and ×12, climbing with speed', () => {
    const s = createScooterSound(asAudioContext(ctx));
    s.set(RIDE_SPEED, 'pulling', 1 / 60);
    const expected = [1, 2, 2.22, 12].map((order) => order * 210);
    whineTonesHz().forEach((hz, i) => {
      expect(hz).toBeCloseTo(expected.at(i) ?? Number.NaN);
    });
    expect(whineTonesHz()).toHaveLength(4);
    s.set(RIDE_SPEED / 2, 'cruising', 1 / 60);
    expect(whineTonesHz().at(0)).toBeCloseTo(105);
  });

  test("each tone has the owner's level, and speeding up brightens the slot tone and ×12 by 1.6", () => {
    const s = createScooterSound(asAudioContext(ctx));
    const gains = (ctx.byKind('gain') as unknown as Gain[]).map((g) => g.gain.value);
    for (const level of [0.12, 0.08, 0.3, 0.06]) {
      expect(gains).toContain(level);
    }
    s.set(3, 'pulling', 1 / 60);
    const brightened = (ctx.byKind('gain') as unknown as Gain[]).filter((g) => g.gain.last?.[0] === 1.6);
    expect(brightened).toHaveLength(1);
    s.set(RIDE_SPEED, 'cruising', 1 / 60);
    expect(brightened.at(0)?.gain.last?.[0]).toBe(1);
  });

  test('the whine shimmers once per wheel turn (23 magnet pairs) and drifts by 6 cents', () => {
    const s = createScooterSound(asAudioContext(ctx));
    s.set(RIDE_SPEED, 'cruising', 1 / 60);
    expect(oscillators().some((o) => o.frequency.value === 210 / 23)).toBe(true);
    expect(whineTones()).toHaveLength(4);
  });

  test('the housing cuts 3 dB round 1500 Hz', () => {
    createScooterSound(asAudioContext(ctx));
    const housing = (ctx.byKind('biquad') as unknown as Peaking[]).find((f) => f.type === 'peaking');
    expect(housing?.frequency.value).toBe(1500);
    expect(housing?.gain.value).toBe(-3);
  });

  test('the whole whiss is half what it was: its tone at 0.325 and its band of hiss at 0.75, still 1 : 2.3', () => {
    createScooterSound(asAudioContext(ctx));
    const gains = (ctx.byKind('gain') as unknown as Gain[]).map((g) => g.gain.value);
    expect(gains).toContain(0.325);
    expect(gains).toContain(0.75);
    expect(gains).not.toContain(0.65);
    expect(gains).not.toContain(1.5);
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
    expect(faded.length).toBe(3);
    for (const o of oscillators()) {
      expect(o.stoppedAt).toBeGreaterThan(ctx.currentTime);
    }
  });
});
