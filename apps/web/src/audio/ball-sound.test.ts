import { BALL_CRIES } from '@zoom3d/shared';
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

// Living ball spec §5: an FM note, a modulator feeding a gliding carrier's frequency.
describe('a cry', () => {
  const SOUND = { startHz: 800, endHz: 400, ratio: 2, depth: 1.5, durationS: 0.5, peak: 0.5 };
  type Osc = { frequency: FakeParam; startedAt?: number; stoppedAt?: number; connections: unknown[] };
  const oscillators = () => ctx.byKind('oscillator') as unknown as Osc[];

  test('the modulator runs at start × ratio, feeding the carrier through a gain of depth × its own frequency', () => {
    createBallSound(asAudioContext(ctx)).cry(SOUND);
    const [carrier, modulator] = oscillators();
    expect(modulator?.frequency.value).toBe(1600);
    const modGain = modulator?.connections.at(0) as { gain: FakeParam; connections: unknown[] };
    expect(modGain.gain.value).toBe(2400);
    expect(modGain.connections).toContain(carrier?.frequency);
  });

  test('the carrier glides from startHz to endHz over its duration', () => {
    createBallSound(asAudioContext(ctx)).cry(SOUND);
    const [carrier] = oscillators();
    expect(carrier?.frequency.events).toEqual([
      ['set', 800, 1],
      ['exponential', 400, 1.5],
    ]);
  });

  test('both oscillators stop at the end of it', () => {
    createBallSound(asAudioContext(ctx)).cry(SOUND);
    for (const osc of oscillators()) {
      expect(osc.stoppedAt).toBe(1.5);
    }
  });

  test('it goes through the master gain', () => {
    const s = createBallSound(asAudioContext(ctx));
    s.cry(SOUND);
    const [carrier] = oscillators();
    const env = carrier?.connections.at(0) as { connections: unknown[] };
    expect(env.connections).toContain(s.output);
  });

  test('its loudest sound peaks at least 12 dB under unity, so it sits below voices', () => {
    const loudest = Math.max(...Object.values(BALL_CRIES).flatMap((sounds) => sounds.map((c) => c.peak)));
    expect(20 * Math.log10(BALL_GAIN * loudest)).toBeLessThanOrEqual(-12);
  });
});
