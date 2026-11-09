import { RIDE_SPEED } from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import {
  buzzCurve,
  buzzDriveDb,
  buzzMakeup,
  createScooterSound,
  fillTicks,
  grainRate,
  magnetHz,
  pwmLevel,
  rollLevel,
  SCOOTER_MASTER,
  type ScooterLoad,
  whineLevel,
} from './scooter-sound';

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

  test('the wheels roll louder with speed: 0.6 at full speed', () => {
    expect(rollLevel(RIDE_SPEED)).toBeCloseTo(0.6);
    expect(rollLevel(3)).toBeCloseTo(0.6 * 0.5 ** 1.2);
    expect(rollLevel(0)).toBe(0);
  });

  test('the ticks play in step with speed, never quite stopping', () => {
    expect(grainRate(RIDE_SPEED)).toBe(1);
    expect(grainRate(-RIDE_SPEED / 2)).toBe(0.5);
    expect(grainRate(0)).toBe(0.001);
  });

  test('the loudest layer sits at least 12 dB under a voice', () => {
    expect(20 * Math.log10(SCOOTER_MASTER * 0.35)).toBeLessThanOrEqual(-12);
  });
});

describe('the buzz', () => {
  test('drives the clipper by load, as the owner tuned it: 14, 5 and 0 dB', () => {
    const loads: ScooterLoad[] = ['pulling', 'cruising', 'coasting'];
    expect(loads.map(buzzDriveDb)).toEqual([14, 5, 0]);
  });

  test('the curve is 4096 points, silent at silence, and squashes without exceeding a full swing', () => {
    const curve = buzzCurve();
    expect(curve).toHaveLength(4096);
    expect(Math.abs(((curve.at(2047) ?? 1) + (curve.at(2048) ?? 1)) / 2)).toBeLessThan(1e-3);
    expect(Math.max(...Array.from(curve, Math.abs))).toBeLessThan(2.2);
  });

  test('it clips one side sooner: its top and bottom differ', () => {
    const curve = buzzCurve();
    expect(Math.abs((curve.at(-1) ?? 0) + (curve.at(0) ?? 0))).toBeGreaterThan(0.05);
  });

  test('the level match brings the clipped peak back to the clean one, finite at 0 dB', () => {
    const curve = buzzCurve();
    /** The curve's output for `x`, as the shaper maps it: ±4 across the points. */
    const shaped = (x: number) => curve.at(Math.round(((x / 4 + 1) / 2) * (curve.length - 1))) ?? 0;
    for (const db of [0, 5, 14]) {
      const drive = 10 ** (db / 20);
      expect(Number.isFinite(buzzMakeup(drive))).toBe(true);
      expect(Math.abs(shaped(0.75 * drive)) * buzzMakeup(drive)).toBeCloseTo(0.75, 2);
    }
  });
});

describe('the rolling ticks', () => {
  test('about 900 a second, Poisson-spaced, at most full height, both ways', () => {
    const data = new Float32Array(48000 * 4);
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    fillTicks(data, 48000, 900, random);
    const ticks = data.filter((v) => v !== 0);
    expect(ticks.length).toBeGreaterThan(3240);
    expect(ticks.length).toBeLessThan(3960);
    expect(Math.max(...Array.from(ticks, Math.abs))).toBeLessThanOrEqual(1);
    expect(ticks.some((v) => v > 0) && ticks.some((v) => v < 0)).toBe(true);
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
    for (const level of [0.12, 0.08, 0.24, 0.06]) {
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

  test('the whine goes pulse → drive → clipper (4x) → 20 Hz highpass → 2310 Hz lowpass → makeup → housing', () => {
    createScooterSound(asAudioContext(ctx));
    const shaper = ctx.byKind('waveshaper').at(0) as unknown as FakeNode & { curve: Float32Array; oversample: string };
    expect(shaper.oversample).toBe('4x');
    expect(Array.from(shaper.curve)).toEqual(Array.from(buzzCurve()));
    const [highpass] = shaper.connections as (Filter & { type: string })[];
    expect([highpass?.type, highpass?.frequency.value]).toEqual(['highpass', 20]);
    const [lowpass] = (highpass?.connections ?? []) as (Filter & { type: string })[];
    expect([lowpass?.type, lowpass?.frequency.value]).toEqual(['lowpass', 2310]);
    const [makeup] = (lowpass?.connections ?? []) as Gain[];
    expect((makeup?.connections.at(0) as Peaking | undefined)?.type).toBe('peaking');
  });

  test('speeding up drives it 14 dB, holding speed 5, coasting 0, with the makeup −5.5 dB on the level match', () => {
    const s = createScooterSound(asAudioContext(ctx));
    const shaper = ctx.byKind('waveshaper').at(0) as unknown as FakeNode;
    const gains = ctx.byKind('gain') as unknown as Gain[];
    const drive = gains.find((g) => g.connections.includes(shaper));
    const makeup = gains.find((g) => (g.connections.at(0) as Peaking | undefined)?.type === 'peaking');
    for (const [load, db] of [
      ['pulling', 14],
      ['cruising', 5],
      ['coasting', 0],
    ] as const) {
      s.set(3, load, 1 / 60);
      expect(drive?.gain.last?.[0]).toBeCloseTo(10 ** (db / 20));
      expect(makeup?.gain.last?.[0]).toBeCloseTo(buzzMakeup(10 ** (db / 20)) * 10 ** (-5.5 / 20));
    }
  });

  test('the wheels roll: ticks into modes at 190, 460 and 1150 Hz (Q 9, 7, 5), lifted 10.8, 4.9 and 1.5', () => {
    createScooterSound(asAudioContext(ctx));
    const modes = [190, 460, 1150].map((hz) => filtersAt(hz).at(0) as (Filter & { Q: FakeParam }) | undefined);
    expect(modes.map((m) => m?.Q.value)).toEqual([9, 7, 5]);
    expect(modes.map((m) => (m?.connections.at(0) as Gain | undefined)?.gain.value)).toEqual([
      expect.closeTo(10.8),
      expect.closeTo(4.9),
      expect.closeTo(1.5),
    ]);
    expect(filtersAt(1260)).toHaveLength(0);
  });

  test("the ticks play faster with speed, and the roll swells once a wheel turn with the whine's pulse", () => {
    const s = createScooterSound(asAudioContext(ctx));
    s.set(3, 'cruising', 1 / 60);
    const ticks = (ctx.byKind('buffer-source') as unknown as (FakeNode & { playbackRate: FakeParam })[]).find(
      (b) => b.playbackRate.last?.[0] === 0.5
    );
    expect(ticks).toBeDefined();
    const swell = (ctx.byKind('gain') as unknown as Gain[]).find((g) => g.gain.value === 0.825);
    const shimmer = oscillators().find((o) => o.frequency.last?.[0] === 105 / 23);
    const depth = shimmer?.connections.find((g) => (g as Gain).gain.value === 0.175) as Gain | undefined;
    expect(depth?.connections).toContain((swell as unknown as { gain: FakeNode }).gain);
  });

  test('the housing cuts 3 dB round 1500 Hz', () => {
    createScooterSound(asAudioContext(ctx));
    const housing = (ctx.byKind('biquad') as unknown as Peaking[]).find((f) => f.type === 'peaking');
    expect(housing?.frequency.value).toBe(1500);
    expect(housing?.gain.value).toBe(-3);
  });

  test('the whole whiss is 10.5% of what it was: its tone at 0.06825 and its band of hiss at 0.1575, still 1 : 2.3', () => {
    createScooterSound(asAudioContext(ctx));
    const gains = (ctx.byKind('gain') as unknown as Gain[]).map((g) => g.gain.value);
    expect(gains).toContain(0.06825);
    expect(gains).toContain(0.1575);
    expect(gains).not.toContain(0.2275);
    expect(gains).not.toContain(0.525);
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
