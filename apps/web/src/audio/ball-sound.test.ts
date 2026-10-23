import { beforeEach, describe, expect, test } from 'vitest';
import { BALL_GAIN, BALL_TONES, createBallSound } from './ball-sound';
import { asAudioContext, FakeAudioContext, type FakeParam } from './fake-audio';

// Ball spec §6: a thump on a kick, a lighter tap on a bounce, both well under a voice.
let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});
const hz = () => ctx.byKind('oscillator').map((o) => (o.frequency as FakeParam).value);

describe('createBallSound', () => {
  test('its output is the master gain, at BALL_GAIN', () => {
    const s = createBallSound(asAudioContext(ctx));
    expect((s.output as unknown as { gain: FakeParam }).gain.value).toBe(BALL_GAIN);
  });

  test('its loudest tone peaks at least 12 dB under unity, so it sits below voices', () => {
    const loudest = Math.max(...Object.values(BALL_TONES).flatMap((tones) => tones.map((t) => t.peak)));
    expect(20 * Math.log10(BALL_GAIN * loudest)).toBeLessThanOrEqual(-12);
  });

  test('it makes no sound until something happens', () => {
    createBallSound(asAudioContext(ctx));
    expect(hz()).toEqual([]);
  });

  test('a kick thumps low and a bounce taps higher', () => {
    const s = createBallSound(asAudioContext(ctx));
    s.kick();
    expect(hz()).toEqual(BALL_TONES.kick.map((t) => t.hz));
    s.bounce();
    expect(hz().slice(BALL_TONES.kick.length)).toEqual(BALL_TONES.bounce.map((t) => t.hz));
    expect(Math.min(...BALL_TONES.bounce.map((t) => t.hz))).toBeGreaterThan(
      Math.min(...BALL_TONES.kick.map((t) => t.hz))
    );
  });

  test('every tone stops by itself', () => {
    const s = createBallSound(asAudioContext(ctx));
    s.kick();
    s.bounce();
    expect(ctx.byKind('oscillator').every((o) => o.stoppedAt !== null)).toBe(true);
  });
});
