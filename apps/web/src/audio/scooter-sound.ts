// An electric scooter's motor (electric scooter spec §4.4): a whine whose pitch follows the speed, a little louder while
// speeding up, silent at rest. Two slightly detuned sawtooths through a band-pass, synthesised like the vacuum's hum.
import { RIDE_SPEED } from '@zoom3d/shared';

/** Master level: under −12 dB, so even beside a rider it sits under a voice, like the vacuum. Tuned by ear. */
export const SCOOTER_GAIN = 0.04;

const CRAWL_HZ = 180;
const TOP_HZ = 720;
/** Below this the motor is idle: a scooter at rest, or barely rolling, says nothing. */
const SILENT_BELOW = 0.3;
const SPEEDING_UP_BOOST = 1.3;
/** The second sawtooth runs this much sharp of the first: their beating is the whine's shimmer. */
const DETUNE = 1.004;
/** Pitch and level glide with this time constant, so a change never clicks. */
const GLIDE_S = 0.1;

export function whinePitchHz(speed: number): number {
  return CRAWL_HZ + (TOP_HZ - CRAWL_HZ) * Math.min(Math.abs(speed) / RIDE_SPEED, 1);
}

export function whineLevel(speed: number, speedingUp: boolean): number {
  const s = Math.abs(speed);
  if (s < SILENT_BELOW) {
    return 0;
  }
  return Math.min(1, (s / RIDE_SPEED) * (speedingUp ? SPEEDING_UP_BOOST : 1));
}

export interface ScooterSound {
  /** Connect this to the audio engine. */
  output: AudioNode;
  set(speed: number, speedingUp: boolean): void;
  dispose(): void;
}

export function createScooterSound(ctx: BaseAudioContext): ScooterSound {
  const master = ctx.createGain();
  master.gain.value = SCOOTER_GAIN;
  const level = ctx.createGain();
  level.gain.value = 0;
  const tone = ctx.createBiquadFilter();
  tone.type = 'bandpass';
  tone.frequency.value = 2 * CRAWL_HZ;
  tone.Q.value = 1;
  tone.connect(level).connect(master);

  const low = ctx.createOscillator();
  low.type = 'sawtooth';
  low.frequency.value = CRAWL_HZ;
  const high = ctx.createOscillator();
  high.type = 'sawtooth';
  high.frequency.value = CRAWL_HZ * DETUNE;
  low.connect(tone);
  high.connect(tone);
  const oscillators = [low, high];
  for (const o of oscillators) {
    o.start(ctx.currentTime);
  }

  return {
    output: master,
    set(speed, speedingUp) {
      const t = ctx.currentTime;
      const hz = whinePitchHz(speed);
      low.frequency.setTargetAtTime(hz, t, GLIDE_S);
      high.frequency.setTargetAtTime(hz * DETUNE, t, GLIDE_S);
      tone.frequency.setTargetAtTime(2 * hz, t, GLIDE_S);
      level.gain.setTargetAtTime(whineLevel(speed, speedingUp), t, GLIDE_S);
    },
    dispose() {
      for (const o of oscillators) {
        o.stop();
      }
      master.disconnect();
    },
  };
}
