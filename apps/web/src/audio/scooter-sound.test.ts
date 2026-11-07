import { RIDE_SPEED } from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createScooterSound, SCOOTER_GAIN, whineLevel, whinePitchHz } from './scooter-sound';

// Electric scooter spec §4.4: a whine whose pitch follows speed, louder while speeding up, silent at rest.
let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});
type FakeOscillator = FakeNode & { type: string; frequency: FakeParam };
const saws = () => (ctx.byKind('oscillator') as unknown as FakeOscillator[]).filter((o) => o.type === 'sawtooth');

describe('the whine', () => {
  test('pitch climbs from 180 Hz to 720 Hz with speed, and no further', () => {
    expect(whinePitchHz(0)).toBe(180);
    expect(whinePitchHz(RIDE_SPEED / 2)).toBe(450);
    expect(whinePitchHz(RIDE_SPEED)).toBe(720);
    expect(whinePitchHz(9)).toBe(720);
    expect(whinePitchHz(-1)).toBe(whinePitchHz(1));
  });

  test('silent below 0.3 tiles/s', () => {
    expect(whineLevel(0.29, true)).toBe(0);
    expect(whineLevel(0.3, false)).toBeGreaterThan(0);
  });

  test('louder while speeding up, never past full', () => {
    expect(whineLevel(3, true)).toBeCloseTo(1.3 * whineLevel(3, false));
    expect(whineLevel(RIDE_SPEED, true)).toBe(1);
  });

  test('SCOOTER_GAIN sits at least 12 dB under a voice', () => {
    expect(20 * Math.log10(SCOOTER_GAIN)).toBeLessThanOrEqual(-12);
  });
});

describe('createScooterSound', () => {
  test('two detuned sawtooths start silent, at the crawl pitch', () => {
    const s = createScooterSound(asAudioContext(ctx));
    expect(saws()).toHaveLength(2);
    expect(saws().at(0)?.frequency.value).toBe(180);
    expect(saws().at(1)?.frequency.value).not.toBe(180);
    expect((s.output as unknown as { gain: FakeParam }).gain.value).toBe(SCOOTER_GAIN);
  });

  test('set glides pitch and level there with a 0.1 s time constant', () => {
    const s = createScooterSound(asAudioContext(ctx));
    s.set(RIDE_SPEED, false);
    const [hz, , tau] = saws().at(0)?.frequency.targets.at(-1) ?? [];
    expect(hz).toBe(720);
    expect(tau).toBe(0.1);
    const levels = (ctx.byKind('gain') as unknown as (FakeNode & { gain: FakeParam })[]).filter(
      (g) => g.gain.targets.length > 0
    );
    expect(levels.at(-1)?.gain.targets.at(-1)).toEqual([1, ctx.currentTime, 0.1]);
  });

  test('dispose stops it', () => {
    const s = createScooterSound(asAudioContext(ctx));
    s.dispose();
    expect(saws().every((o) => (o as unknown as { stoppedAt: number | null }).stoppedAt !== null)).toBe(true);
  });
});
