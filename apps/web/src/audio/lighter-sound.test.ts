import { beforeEach, describe, expect, test } from 'vitest';
import { asAudioContext, FakeAudioContext, type FakeParam } from './fake-audio';
import { createLighterSound, LIGHTER_GAIN, LIGHTER_TONES } from './lighter-sound';

// Lighter spec §3.5: a flick of the lid and a strike when it's lit, a snap of the lid when it's put away.
let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});
const hz = () => ctx.byKind('oscillator').map((o) => (o.frequency as FakeParam).value);
const strikes = () => ctx.byKind('buffer-source');

describe('createLighterSound', () => {
  test('its output is the master gain, at LIGHTER_GAIN', () => {
    const s = createLighterSound(asAudioContext(ctx));
    expect((s.output as unknown as { gain: FakeParam }).gain.value).toBe(LIGHTER_GAIN);
  });

  test('its loudest part peaks at least 12 dB under unity, so it sits below voices', () => {
    const loudest = Math.max(...Object.values(LIGHTER_TONES).flatMap((tones) => tones.map((t) => t.peak)));
    expect(20 * Math.log10(LIGHTER_GAIN * loudest)).toBeLessThanOrEqual(-12);
  });

  test('it makes no sound until the lighter is lit or put away', () => {
    createLighterSound(asAudioContext(ctx));
    expect(hz()).toEqual([]);
    expect(strikes()).toEqual([]);
  });

  test('lighting it clicks the lid open and strikes the flint', () => {
    createLighterSound(asAudioContext(ctx)).on();
    expect(hz()).toEqual(LIGHTER_TONES.open.map((t) => t.hz));
    expect(strikes()).toHaveLength(1);
  });

  test('putting it away snaps the lid shut, lower, with no strike', () => {
    createLighterSound(asAudioContext(ctx)).off();
    expect(hz()).toEqual(LIGHTER_TONES.close.map((t) => t.hz));
    expect(strikes()).toHaveLength(0);
    expect(Math.min(...LIGHTER_TONES.close.map((t) => t.hz))).toBeLessThan(
      Math.min(...LIGHTER_TONES.open.map((t) => t.hz))
    );
  });

  test('every part stops by itself', () => {
    const s = createLighterSound(asAudioContext(ctx));
    s.on();
    s.off();
    expect(ctx.byKind('oscillator').every((o) => o.stoppedAt !== null)).toBe(true);
    expect(strikes().every((o) => o.stoppedAt !== null)).toBe(true);
  });
});
