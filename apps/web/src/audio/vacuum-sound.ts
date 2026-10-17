// The robot vacuum's hum (robot vacuum spec §5): variant B "soft purr", picked by ear in the 2026-10-11 brainstorm.
// Airflow, brush and a low motor, all synthesised; the motor drops while it turns or stands, and bumps and the lost
// beeps play through the same output, so the engine spatialises all of it.
import type { PlayerState } from '@zoom3d/shared';

/** Master level: about −28 dB, so even right beside it the hum sits well under a voice (spec §5.3). Tuned by ear. */
export const VACUUM_GAIN = 0.04;

export type Motion = 'drive' | 'turn' | 'still';

const MOTOR_HZ: Record<Motion, number> = { drive: 110, turn: 99, still: 91 };
const MOTION_GAIN: Record<Motion, number> = { drive: 1, turn: 0.85, still: 0.7 };
const MOTION_TAU = 0.15;
const DRIVE_TILES_PER_S = 0.2;
const TURN_RAD_PER_S = 0.3;
const TWO_PI = Math.PI * 2;

/** The bumper's thud, and the two "lost" beeps, high then low. */
type Tone =
  | { kind: 'thud'; hz: number; peak: number; decayTau: number }
  | { kind: 'beep'; hz: number; peak: number; holdS: number };
const THUD: Tone = { kind: 'thud', hz: 70, peak: 1.2, decayTau: 0.04 };
const HIGH_BEEP: Tone = { kind: 'beep', hz: 880, peak: 0.35, holdS: 0.18 };
const LOW_BEEP: Tone = { kind: 'beep', hz: 660, peak: 0.35, holdS: 0.18 };
/** The low beep follows the high one after this long. */
const LOST_BEEP_GAP_S = 0.43;
/** Every tone rises this fast, so it doesn't click. */
const TONE_ATTACK_S = 0.004;
const BEEP_RELEASE_S = 0.01;
/** A tone's oscillator runs at least this long, so a thud's decay fades out first. */
const TONE_MIN_S = 0.3;
/** On a bump the motor strains down to this pitch, then eases back to its own after a moment. */
const BUMP_STRAIN_HZ = 86;
const BUMP_STRAIN_S = 0.05;
const BUMP_RECOVERY_TAU = 0.08;

/** What the robot is doing between two poses `dtSeconds` apart. */
export function motionOf(prev: PlayerState, cur: PlayerState, dtSeconds: number): Motion {
  if (dtSeconds <= 0) {
    return 'still';
  }
  if (Math.hypot(cur.x - prev.x, cur.y - prev.y) / dtSeconds > DRIVE_TILES_PER_S) {
    return 'drive';
  }
  const turn = Math.abs(cur.angle - prev.angle) % TWO_PI;
  return Math.min(turn, TWO_PI - turn) / dtSeconds > TURN_RAD_PER_S ? 'turn' : 'still';
}

export interface VacuumSound {
  /** Connect this to the audio engine (`attachNode`). */
  output: AudioNode;
  setMotion(m: Motion): void;
  bump(): void;
  lost(): void;
  dispose(): void;
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

export function createVacuumSound(ctx: BaseAudioContext): VacuumSound {
  const t = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = VACUUM_GAIN;
  const motion = ctx.createGain();
  motion.gain.value = 1;
  motion.connect(master);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  noise.loop = true;

  // Airflow: a soft band of noise around 900 Hz.
  const air = ctx.createBiquadFilter();
  air.type = 'bandpass';
  air.frequency.value = 900;
  air.Q.value = 0.5;
  const airGain = ctx.createGain();
  airGain.gain.value = 0.45;
  noise.connect(air).connect(airGain).connect(motion);

  // Brush: low noise fluttering at 8 Hz (gain 0.5 ± 0.3).
  const brush = ctx.createBiquadFilter();
  brush.type = 'lowpass';
  brush.frequency.value = 250;
  const brushGain = ctx.createGain();
  brushGain.gain.value = 0.5;
  const flutter = ctx.createOscillator();
  flutter.frequency.value = 8;
  const flutterDepth = ctx.createGain();
  flutterDepth.gain.value = 0.3;
  flutter.connect(flutterDepth).connect(brushGain.gain);
  noise.connect(brush).connect(brushGain).connect(motion);

  // Motor: a low triangle purr with a slow ±2 Hz wobble.
  const motor = ctx.createOscillator();
  motor.type = 'triangle';
  motor.frequency.value = MOTOR_HZ.drive;
  const motorTone = ctx.createBiquadFilter();
  motorTone.type = 'lowpass';
  motorTone.frequency.value = 500;
  const motorGain = ctx.createGain();
  motorGain.gain.value = 0.45;
  const wobble = ctx.createOscillator();
  wobble.frequency.value = 0.25;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 2;
  wobble.connect(wobbleDepth).connect(motor.frequency);
  motor.connect(motorTone).connect(motorGain).connect(motion);

  const sources = [noise, flutter, motor, wobble];
  for (const s of sources) {
    s.start(t);
  }
  let current: Motion = 'drive';

  /** Into the master gain, `atS` seconds from now: a beep holds then releases, a thud decays at once. */
  const playTone = (tone: Tone, atS: number) => {
    const start = ctx.currentTime + atS;
    const osc = ctx.createOscillator();
    osc.frequency.value = tone.hz;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(tone.peak, start + TONE_ATTACK_S);
    let soundsS = 0;
    if (tone.kind === 'beep') {
      env.gain.setValueAtTime(tone.peak, start + tone.holdS);
      env.gain.linearRampToValueAtTime(0, start + tone.holdS + BEEP_RELEASE_S);
      soundsS = tone.holdS + 2 * BEEP_RELEASE_S;
    } else {
      env.gain.setTargetAtTime(0, start + TONE_ATTACK_S, tone.decayTau);
    }
    osc.connect(env).connect(master);
    osc.start(start);
    osc.stop(start + Math.max(soundsS, TONE_MIN_S));
    osc.onended = () => env.disconnect();
  };

  return {
    output: master,

    setMotion(m) {
      if (m === current) {
        return;
      }
      current = m;
      const now = ctx.currentTime;
      motor.frequency.setTargetAtTime(MOTOR_HZ[m], now, MOTION_TAU);
      motion.gain.setTargetAtTime(MOTION_GAIN[m], now, MOTION_TAU);
    },

    bump() {
      const now = ctx.currentTime;
      // The motor strains for a moment, and the bumper thuds.
      motor.frequency.cancelScheduledValues(now);
      motor.frequency.setValueAtTime(BUMP_STRAIN_HZ, now);
      motor.frequency.setTargetAtTime(MOTOR_HZ[current], now + BUMP_STRAIN_S, BUMP_RECOVERY_TAU);
      playTone(THUD, 0);
    },

    lost() {
      playTone(HIGH_BEEP, 0);
      playTone(LOW_BEEP, LOST_BEEP_GAP_S);
    },

    dispose() {
      const now = ctx.currentTime;
      for (const s of sources) {
        s.stop(now);
      }
      master.disconnect();
    },
  };
}
