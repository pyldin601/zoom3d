// An electric scooter's sound (scooter sound spec §4), tuned by the owner by ear on listening pages: the controller's
// PWM whiss at one fixed pitch, the hub motor's magnetic whine climbing with the wheel, the wheels barely heard with a
// tick at each floor seam, and a thud with a rattle on a bump. The load (speeding up, holding speed, coasting) sets how
// loud the whiss and the whine are. Synthesised like the vacuum's hum.
//
// The buzz and the roll (motor buzz spec, 2026-11-09, tuned by the owner on the Scooter Motor Buzz page): the whine is
// driven into a soft clipper, harder the harder the motor pulls, so it grows harmonics and grit; and the wheels roll
// instead of hissing: tiny random ticks from tread and floor, more the faster they turn, each striking three wheel
// and deck resonances, the whole swelling once a turn.
//
// The whine (owner, 2026-11-08: like gears, but magnetic): magnets sweep past coil slots on every wheel turn, and each
// pass is a small magnetic tug, so the motor sounds tones at fixed multiples of the magnet rate. The slot tone sits
// between the harmonics, which makes it sound like teeth. A rotor never quite round pulses it once per turn, and its
// pitch wanders a few cents.
import { RIDE_SPEED } from '@zoom3d/shared';

export type ScooterLoad = 'pulling' | 'cruising' | 'coasting';

/** The bench's master: the whiss pulling away, the loudest layer, then peaks about 13.5 dB under a voice. */
export const SCOOTER_MASTER = 0.6;

const PWM_HZ = 7800;
const PWM_LEVEL: Record<ScooterLoad, number> = { pulling: 0.35, cruising: 0.18, coasting: 0.02 };
/**
 * Tone and hiss go down together, never the hiss alone: cut to a tenth on its own, it left a bare whistle that
 * sounded weird (owner, 2026-11-08). From 0.65 and 1.5 (the hiss already half the bench's 3, owner, 2026-11-07), they
 * were halved (2026-11-08), taken 30% lower (2026-11-09), then to 30% of that, still too loud (2026-11-09).
 */
const PWM_TONE_GAIN = 0.06825;
const PWM_HISS_GAIN = 0.1575;
const PWM_HISS_Q = 12;
/** How many magnet pairs pass a coil each second at full speed. */
const MAGNET_HZ_AT_TOP = 210;
/** Magnet pairs per wheel turn: the shimmer pulses at the magnet rate over this. */
const MAGNET_PAIRS = 23;
/** The whine's tones, as multiples of the magnet rate, with their levels; `upper` ones brighten when pulling. */
const WHINE_TONES = [
  { order: 1, level: 0.12, upper: false },
  { order: 2, level: 0.08, upper: false },
  // The slot tone: coil slots per magnet pair.
  { order: 2.22, level: 0.24, upper: true },
  { order: 12, level: 0.06, upper: true },
] as const;
const WHINE_LEVEL: Record<ScooterLoad, number> = { pulling: 0.1, cruising: 0.05, coasting: 0.008 };
const PULLING_BRIGHTEN = 1.6;
/** How deep the once-a-turn pulse goes: the whine dips to 1 − this. */
const SHIMMER = 0.3;
const DRIFT_CENTS = 6;
const DRIFT_KNOTS_PER_S = 7;
const DRIFT_LOOP_S = 8;
const HOUSING_HZ = 1500;
const HOUSING_Q = 1.5;
const HOUSING_DB = -3;
const BUZZ_DRIVE_DB: Record<ScooterLoad, number> = { pulling: 14, cruising: 5, coasting: 0 };
/** 0 is a round tanh; toward 1 the knee sharpens, for more high harmonics. */
const BUZZ_HARDNESS = 0.28;
/** Shifts the input so one side clips first: even harmonics, the hummier half of a motor buzz. */
const BUZZ_ASYMMETRY = 0.19;
const BUZZ_CURVE_RANGE = 4;
const BUZZ_CURVE_POINTS = 4096;
/** About the loudest the summed whine reaches into the clipper (pulling, upper bus ×1.6): the level match's mark. */
const WHINE_PEAK = 0.75;
/** Below the ear: takes away the offset the asymmetry adds. */
const BUZZ_DC_HZ = 20;
const BUZZ_TONE_HZ = 2310;
const BUZZ_FILTER_Q = 0.7;
const BUZZ_MAKEUP_DB = -5.5;
const ROLL_LEVEL = 0.6;
const TICKS_PER_S_AT_TOP = 900;
const TICK_LOOP_S = 4;
/** A slower tick rate never reaches 0: a buffer played at rate 0 would hang on one sample. */
const MIN_TICK_RATE = 0.001;
const ROLL_SWELL = 0.35;
/** What each tick strikes: the wheel core and deck thump, the deck plate, the hard tread. */
const WHEEL_MODES = [
  { hz: 190, q: 9, level: 0.6 },
  { hz: 460, q: 7, level: 0.35 },
  { hz: 1150, q: 5, level: 0.15 },
] as const;
/** Coasting fades in over the first 0.3 tiles/s, and seams tick only above it: a scooter at rest is silent. */
const MOVING_TILES_PER_S = 0.3;
const SEAM_EVERY_TILES = 1;
const SEAM_HZ = 3200;
const SEAM_Q = 2;
const SEAM_LEVEL = 0.15;
const SEAM_DECAY_S = 0.03;
const SEAM_LENGTH_S = 0.05;
const THUD_HZ = 85;
const THUD_SWEEP = 1.6;
const THUD_SWEEP_S = 0.05;
const THUD_ATTACK_S = 0.004;
const THUD_DECAY_TAU_S = 0.06;
const RATTLE_HZ = 1500;
const RATTLE_Q = 3;
const RATTLE_DECAY_TAU_S = 0.03;
const BUMP_LEVEL = 0.45;
/** Every level and pitch glides with this time constant, so nothing clicks. */
const GLIDE_S = 0.05;
/** A stopping sound fades for this many glide constants (under 1% left) before its sources stop. */
const FADE_GLIDES = 5;

const speedShare = (speed: number) => Math.min(1, Math.abs(speed) / RIDE_SPEED);
const moving = (speed: number) => Math.min(1, Math.abs(speed) / MOVING_TILES_PER_S);

export function pwmLevel(load: ScooterLoad, speed: number): number {
  return load === 'coasting' ? PWM_LEVEL.coasting * moving(speed) : PWM_LEVEL[load];
}

export function whineLevel(load: ScooterLoad, speed: number): number {
  return WHINE_LEVEL[load] * moving(speed);
}

/** How many magnet pairs pass a coil each second: in step with the wheel, either way round. */
export function magnetHz(speed: number): number {
  return MAGNET_HZ_AT_TOP * speedShare(speed);
}

export function rollLevel(speed: number): number {
  return ROLL_LEVEL * speedShare(speed) ** 1.2;
}

/** How fast the tick loop plays: in step with the wheels. */
export function grainRate(speed: number): number {
  return Math.max(MIN_TICK_RATE, speedShare(speed));
}

export function buzzDriveDb(load: ScooterLoad): number {
  return BUZZ_DRIVE_DB[load];
}

/** The clipper: a tanh blended toward a harder knee by the hardness. */
function clip(x: number): number {
  const k = 1 + BUZZ_HARDNESS * 6;
  const hard = Math.max(-1, Math.min(1, Math.tanh(k * x) / Math.tanh(k)));
  return Math.tanh(x) * (1 - BUZZ_HARDNESS) + hard * BUZZ_HARDNESS;
}

/** The clipper shifted by the asymmetry and re-centred, so silence stays silent. */
const shifted = (x: number) => clip(x + BUZZ_ASYMMETRY) - clip(BUZZ_ASYMMETRY);

/** The `WaveShaperNode` curve: the shifted clipper over ±BUZZ_CURVE_RANGE. */
export function buzzCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(BUZZ_CURVE_POINTS);
  for (let i = 0; i < curve.length; i++) {
    curve[i] = shifted(((i / (curve.length - 1)) * 2 - 1) * BUZZ_CURVE_RANGE);
  }
  return curve;
}

/** Lifts the clipped whine's peak back to where it was clean: the curve squashes a driven peak by this much. */
export function buzzMakeup(driveGain: number): number {
  const out = Math.abs(shifted(WHINE_PEAK * driveGain));
  return out > 1e-6 ? WHINE_PEAK / out : 1;
}

/** Sparse ticks, Poisson-spaced at `perSecond`, with random heights (mostly small) and signs. */
export function fillTicks(data: Float32Array, sampleRate: number, perSecond: number, random = Math.random): void {
  for (let t = -Math.log(1 - random()) / perSecond; ; t += -Math.log(1 - random()) / perSecond) {
    const i = Math.floor(t * sampleRate);
    if (i >= data.length) {
      return;
    }
    data[i] = Math.min(1, -Math.log(1 - random()) * 0.4) * (random() < 0.5 ? -1 : 1);
  }
}

export interface ScooterSound {
  /** Connect this to the audio engine. */
  output: AudioNode;
  /** Every frame: the speed (tiles/s), the load, and the frame's length, which carries the scooter over floor seams. */
  set(speed: number, load: ScooterLoad, dtSeconds: number): void;
  /**
   * A wall hit; `impact` 0..1 is the speed it hit at, as a share of full speed. `inSeconds` from now: another rider's
   * stop is heard when it is drawn.
   */
  bump(impact: number, inSeconds?: number): void;
  /** Fades out, then stops; `whenSilent` runs once the fade is over (to let go of the output). */
  dispose(whenSilent?: () => void): void;
}

/** Two seconds of white noise, looped by the caller. */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** The tick loop, at the full-speed rate. */
function tickBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * TICK_LOOP_S, ctx.sampleRate);
  fillTicks(buffer.getChannelData(0), ctx.sampleRate, TICKS_PER_S_AT_TOP);
  return buffer;
}

/** A looped smooth random wander in −1..1, a few new targets a second, eased between them: the whine's drift. */
function driftBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * DRIFT_LOOP_S, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const knots = Array.from({ length: DRIFT_LOOP_S * DRIFT_KNOTS_PER_S }, () => Math.random() * 2 - 1);
  const knotAt = (i: number) => knots.at(i % knots.length) ?? 0;
  for (let i = 0; i < data.length; i++) {
    const x = (i / data.length) * knots.length;
    const k = Math.floor(x);
    const t = x - k;
    const eased = t * t * (3 - 2 * t);
    data[i] = knotAt(k) * (1 - eased) + knotAt(k + 1) * eased;
  }
  return buffer;
}

export function createScooterSound(ctx: BaseAudioContext): ScooterSound {
  const master = ctx.createGain();
  master.gain.value = SCOOTER_MASTER;
  const noise = noiseBuffer(ctx);
  const loopedNoise = () => {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    return source;
  };
  const layer = () => {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(master);
    return gain;
  };
  const bandPass = (hz: number, q: number) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = hz;
    filter.Q.value = q;
    return filter;
  };
  const gainOf = (value: number) => {
    const gain = ctx.createGain();
    gain.gain.value = value;
    return gain;
  };

  // The PWM whiss: a sine at the switching frequency, in a narrow band of hiss.
  const pwm = layer();
  const pwmTone = ctx.createOscillator();
  pwmTone.frequency.value = PWM_HZ;
  pwmTone.connect(gainOf(PWM_TONE_GAIN)).connect(pwm);
  const pwmHiss = loopedNoise();
  pwmHiss.connect(bandPass(PWM_HZ, PWM_HISS_Q)).connect(gainOf(PWM_HISS_GAIN)).connect(pwm);

  // The whine: one sine per tone into a lower and an upper bus, pulsed once a turn, driven into the clipper, through
  // the housing's dip.
  const whine = layer();
  const housing = ctx.createBiquadFilter();
  housing.type = 'peaking';
  housing.frequency.value = HOUSING_HZ;
  housing.Q.value = HOUSING_Q;
  housing.gain.value = HOUSING_DB;
  housing.connect(whine);
  const pulse = gainOf(1 - SHIMMER / 2);
  const drive = gainOf(1);
  const shaper = ctx.createWaveShaper();
  shaper.curve = buzzCurve();
  shaper.oversample = '4x';
  const dcBlock = ctx.createBiquadFilter();
  dcBlock.type = 'highpass';
  dcBlock.frequency.value = BUZZ_DC_HZ;
  dcBlock.Q.value = BUZZ_FILTER_Q;
  const buzzTone = ctx.createBiquadFilter();
  buzzTone.type = 'lowpass';
  buzzTone.frequency.value = BUZZ_TONE_HZ;
  buzzTone.Q.value = BUZZ_FILTER_Q;
  const makeup = gainOf(1);
  pulse.connect(drive).connect(shaper).connect(dcBlock).connect(buzzTone).connect(makeup).connect(housing);
  const shimmer = ctx.createOscillator();
  shimmer.frequency.value = 0;
  shimmer.connect(gainOf(SHIMMER / 2)).connect(pulse.gain);
  const lower = gainOf(1);
  const upper = gainOf(1);
  lower.connect(pulse);
  upper.connect(pulse);
  const drift = ctx.createBufferSource();
  drift.buffer = driftBuffer(ctx);
  drift.loop = true;
  const driftCents = gainOf(DRIFT_CENTS);
  drift.connect(driftCents);
  const tones = WHINE_TONES.map((tone) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = 0;
    driftCents.connect(osc.detune);
    osc.connect(gainOf(tone.level)).connect(tone.upper ? upper : lower);
    return { osc, order: tone.order };
  });

  // The wheels: ticks into the modes, swelling once a turn with the whine's pulse. A band-pass's ring from one tick
  // is about 1/Q as tall, so each mode is lifted by 2Q: Q sets how long it rings, not how loud.
  const wheels = layer();
  const swell = gainOf(1 - ROLL_SWELL / 2);
  swell.connect(wheels);
  shimmer.connect(gainOf(ROLL_SWELL / 2)).connect(swell.gain);
  const ticks = ctx.createBufferSource();
  ticks.buffer = tickBuffer(ctx);
  ticks.loop = true;
  ticks.playbackRate.value = MIN_TICK_RATE;
  for (const mode of WHEEL_MODES) {
    ticks
      .connect(bandPass(mode.hz, mode.q))
      .connect(gainOf(2 * mode.q * mode.level))
      .connect(swell);
  }

  const sources = [pwmTone, pwmHiss, shimmer, drift, ...tones.map((t) => t.osc), ticks];
  for (const s of sources) {
    s.start(ctx.currentTime);
  }
  const layers = [pwm, whine, wheels];
  let travelled = 0;

  const glide = (param: AudioParam, value: number) => param.setTargetAtTime(value, ctx.currentTime, GLIDE_S);

  /** A short burst of noise through the seam's band, gone in 30 ms. */
  const seamTick = (speed: number) => {
    const t = ctx.currentTime;
    const burst = ctx.createBufferSource();
    burst.buffer = noise;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(SEAM_LEVEL * speedShare(speed) * 0.5, t);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + SEAM_DECAY_S);
    burst.connect(bandPass(SEAM_HZ, SEAM_Q)).connect(envelope).connect(master);
    burst.start(t, Math.random());
    burst.stop(t + SEAM_LENGTH_S);
  };

  return {
    output: master,
    set(speed, load, dtSeconds) {
      glide(pwm.gain, pwmLevel(load, speed));
      const magnets = magnetHz(speed);
      for (const tone of tones) {
        glide(tone.osc.frequency, tone.order * magnets);
      }
      glide(shimmer.frequency, magnets / MAGNET_PAIRS);
      glide(upper.gain, load === 'pulling' ? PULLING_BRIGHTEN : 1);
      glide(whine.gain, whineLevel(load, speed));
      const driveGain = 10 ** (buzzDriveDb(load) / 20);
      glide(drive.gain, driveGain);
      glide(makeup.gain, buzzMakeup(driveGain) * 10 ** (BUZZ_MAKEUP_DB / 20));
      glide(ticks.playbackRate, grainRate(speed));
      glide(wheels.gain, rollLevel(speed));
      if (Math.abs(speed) <= MOVING_TILES_PER_S) {
        return;
      }
      const before = Math.floor(travelled / SEAM_EVERY_TILES);
      travelled += Math.abs(speed) * Math.max(dtSeconds, 0);
      if (Math.floor(travelled / SEAM_EVERY_TILES) !== before) {
        seamTick(speed);
      }
    },
    bump(impact, inSeconds = 0) {
      const t = ctx.currentTime + inSeconds;
      const level = BUMP_LEVEL * impact;
      const thud = ctx.createOscillator();
      thud.frequency.setValueAtTime(THUD_HZ * THUD_SWEEP, t);
      thud.frequency.exponentialRampToValueAtTime(THUD_HZ, t + THUD_SWEEP_S);
      const thudEnvelope = ctx.createGain();
      thudEnvelope.gain.setValueAtTime(0, t);
      thudEnvelope.gain.linearRampToValueAtTime(level, t + THUD_ATTACK_S);
      thudEnvelope.gain.setTargetAtTime(0, t + THUD_ATTACK_S, THUD_DECAY_TAU_S);
      thud.connect(thudEnvelope).connect(master);
      thud.start(t);
      thud.stop(t + 10 * THUD_DECAY_TAU_S);

      const rattle = ctx.createBufferSource();
      rattle.buffer = noise;
      const rattleEnvelope = ctx.createGain();
      rattleEnvelope.gain.setValueAtTime(level * 0.5, t);
      rattleEnvelope.gain.setTargetAtTime(0, t, RATTLE_DECAY_TAU_S);
      rattle.connect(bandPass(RATTLE_HZ, RATTLE_Q)).connect(rattleEnvelope).connect(master);
      rattle.start(t, Math.random());
      rattle.stop(t + 10 * RATTLE_DECAY_TAU_S);
    },
    dispose(whenSilent) {
      const t = ctx.currentTime;
      for (const gain of layers) {
        gain.gain.setTargetAtTime(0, t, GLIDE_S);
      }
      pwmTone.onended = () => {
        master.disconnect();
        whenSilent?.();
      };
      for (const s of sources) {
        s.stop(t + FADE_GLIDES * GLIDE_S);
      }
    },
  };
}
