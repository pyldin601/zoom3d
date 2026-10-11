import { beforeEach, describe, expect, test } from 'vitest';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createVacuumSound, motionOf, VACUUM_GAIN } from './vacuum-sound';

// Robot vacuum spec §5: variant B "soft purr", synthesised, reacting to how the robot moves.
let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});

const oscillators = () => ctx.byKind('oscillator') as (FakeNode & Record<string, unknown>)[];
type FakeOscillator = FakeNode & { frequency: FakeParam; startedAt: number | null; stoppedAt: number | null };
const motor = () => oscillators().find((o) => o.type === 'triangle') as unknown as FakeOscillator;

describe('createVacuumSound', () => {
  test('its output is the master gain, at VACUUM_GAIN', () => {
    const s = createVacuumSound(asAudioContext(ctx));
    expect((s.output as unknown as { gain: FakeParam }).gain.value).toBe(VACUUM_GAIN);
  });

  test('VACUUM_GAIN is at least 12 dB under unity, so it sits below voices', () => {
    expect(20 * Math.log10(VACUUM_GAIN)).toBeLessThanOrEqual(-12);
  });

  test('a looping noise source and a 110 Hz triangle motor start', () => {
    createVacuumSound(asAudioContext(ctx));
    const [noise] = ctx.byKind('buffer-source');
    expect(noise?.loop).toBe(true);
    expect(noise?.startedAt).not.toBeNull();
    expect(motor().frequency.value).toBe(110);
    expect(motor().startedAt).not.toBeNull();
  });

  test('turning drops the motor to 99 Hz, standing still to 91 Hz, driving brings it back', () => {
    const s = createVacuumSound(asAudioContext(ctx));
    s.setMotion('turn');
    expect(motor().frequency.last?.[0]).toBe(99);
    s.setMotion('still');
    expect(motor().frequency.last?.[0]).toBe(91);
    s.setMotion('drive');
    expect(motor().frequency.last?.[0]).toBe(110);
  });

  test('a bump starts a 70 Hz thud, stopped shortly after', () => {
    const s = createVacuumSound(asAudioContext(ctx));
    s.bump();
    const thud = oscillators().find((o) => (o.frequency as FakeParam).value === 70);
    expect(thud?.startedAt).toBe(ctx.currentTime);
    expect(thud?.stoppedAt).toBeCloseTo(ctx.currentTime + 0.3);
  });

  test('lost plays two beeps, 880 then 660 Hz', () => {
    const s = createVacuumSound(asAudioContext(ctx));
    s.lost();
    const beeps = oscillators()
      .filter((o) => [880, 660].includes((o.frequency as FakeParam).value))
      .map((o) => [
        (o.frequency as FakeParam).value,
        Math.round(((o.startedAt as number) - ctx.currentTime) * 100) / 100,
      ]);
    expect(beeps).toEqual([
      [880, 0],
      [660, 0.43],
    ]);
  });

  test('dispose stops the sources and disconnects the output', () => {
    const s = createVacuumSound(asAudioContext(ctx));
    s.dispose();
    expect(ctx.byKind('buffer-source')[0]?.stoppedAt).not.toBeNull();
    expect(motor().stoppedAt).not.toBeNull();
    expect((s.output as unknown as FakeNode).disconnected).toBe(true);
  });
});

describe('motionOf', () => {
  const at = (x: number, y: number, angle = 0) => ({ x, y, angle });

  test('moving over 0.2 tiles/s is driving', () => {
    expect(motionOf(at(1, 1), at(1.06, 1), 0.1)).toBe('drive');
  });

  test('turning in place over 0.3 rad/s is turning, across the 2π wrap too', () => {
    expect(motionOf(at(1, 1, 0), at(1, 1, 0.15), 0.1)).toBe('turn');
    expect(motionOf(at(1, 1, 6.2), at(1, 1, 0.1), 0.1)).toBe('turn');
    expect(motionOf(at(1, 1, 6.2), at(1, 1, 6.21), 0.1)).toBe('still');
  });

  test('otherwise, or with no time passed, it is still', () => {
    expect(motionOf(at(1, 1), at(1.01, 1), 0.1)).toBe('still');
    expect(motionOf(at(1, 1), at(2, 1), 0)).toBe('still');
  });
});
