// An electric scooter's sound (scooter sound spec §4), tuned by the owner by ear on a listening page: the controller's
// PWM whiss at one fixed pitch, the wheels barely heard with a tick at each floor seam, and a thud with a rattle on a
// bump. The load (speeding up, holding speed, coasting) sets how loud the whiss is. Synthesised like the vacuum's hum.
import { RIDE_SPEED } from '@zoom3d/shared';

export type ScooterLoad = 'pulling' | 'cruising' | 'coasting';

/** The bench's master: the whiss pulling away, the loudest layer, then peaks about 13.5 dB under a voice. */
export const SCOOTER_MASTER = 0.6;

const PWM_HZ = 7800;
const PWM_LEVEL: Record<ScooterLoad, number> = { pulling: 0.35, cruising: 0.18, coasting: 0.02 };
const PWM_TONE_GAIN = 0.65;
/** Half the bench's 3 (owner, 2026-11-07: 80% was still too loud). */
const PWM_HISS_GAIN = 1.5;
const PWM_HISS_Q = 12;
const WHEEL_HZ = 1800;
const WHEEL_Q = 0.8;
const WHEEL_LEVEL = 0.12;
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

export function wheelLevel(speed: number): number {
  return WHEEL_LEVEL * speedShare(speed) ** 1.2;
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

  // The wheels: rolling noise in a soft band.
  const wheels = layer();
  const roll = loopedNoise();
  const rollBand = bandPass(WHEEL_HZ * 0.7, WHEEL_Q);
  roll.connect(rollBand).connect(wheels);

  const sources = [pwmTone, pwmHiss, roll];
  for (const s of sources) {
    s.start(ctx.currentTime);
  }
  const layers = [pwm, wheels];
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
      glide(rollBand.frequency, WHEEL_HZ * (0.7 + 0.3 * speedShare(speed)));
      glide(wheels.gain, wheelLevel(speed));
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
