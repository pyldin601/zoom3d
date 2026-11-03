// The ball's sounds (ball spec §6): a soft leather thump on a kick and a lighter tap on a bounce, synthesised. No hum:
// it is silent while it rolls. Its emotions are FM notes (living ball spec §5).
import type { BallCrySound } from '@zoom3d/shared';

/** Master level: like the vacuum's, so even a kick right beside the listener stays well under a voice. */
export const BALL_GAIN = 0.15;

interface Tone {
  hz: number;
  peak: number;
  /** Time constant of the decay. */
  decayTauS: number;
}

/** A kick is a low body with a short slap on top; a bounce is the same, smaller and higher. */
export const BALL_TONES: Record<'kick' | 'bounce', readonly Tone[]> = {
  kick: [
    { hz: 90, peak: 1, decayTauS: 0.035 },
    { hz: 220, peak: 0.4, decayTauS: 0.012 },
  ],
  bounce: [
    { hz: 140, peak: 0.5, decayTauS: 0.02 },
    { hz: 330, peak: 0.2, decayTauS: 0.008 },
  ],
};
/** Every tone rises this fast, so it doesn't click. */
const ATTACK_S = 0.003;
/** A tone's oscillator runs this long, by when its decay has faded out. */
const TONE_S = 0.25;

/** Softer than a tone's attack: a cry is a voice, not a hit. */
const CRY_ATTACK_S = 0.012;

export interface BallSound {
  output: AudioNode;
  kick(): void;
  bounce(): void;
  cry(sound: BallCrySound): void;
  dispose(): void;
}

export function createBallSound(ctx: BaseAudioContext): BallSound {
  const master = ctx.createGain();
  master.gain.value = BALL_GAIN;

  const play = (tones: readonly Tone[]) => {
    const start = ctx.currentTime;
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      osc.frequency.value = tone.hz;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(tone.peak, start + ATTACK_S);
      env.gain.setTargetAtTime(0, start + ATTACK_S, tone.decayTauS);
      osc.connect(env).connect(master);
      osc.start(start);
      osc.stop(start + TONE_S);
      osc.onended = () => env.disconnect();
    }
  };

  return {
    output: master,
    kick: () => play(BALL_TONES.kick),
    bounce: () => play(BALL_TONES.bounce),
    cry(sound) {
      const start = ctx.currentTime;
      const end = start + sound.durationS;
      const carrier = ctx.createOscillator();
      carrier.frequency.setValueAtTime(sound.startHz, start);
      carrier.frequency.exponentialRampToValueAtTime(sound.endHz, end);
      const modulator = ctx.createOscillator();
      modulator.frequency.value = sound.startHz * sound.ratio;
      const modulation = ctx.createGain();
      modulation.gain.value = sound.depth * modulator.frequency.value;
      modulator.connect(modulation).connect(carrier.frequency);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(sound.peak, start + CRY_ATTACK_S);
      env.gain.linearRampToValueAtTime(0, end);
      carrier.connect(env).connect(master);
      carrier.start(start);
      modulator.start(start);
      carrier.stop(end);
      modulator.stop(end);
      carrier.onended = () => {
        env.disconnect();
        modulation.disconnect();
      };
    },
    dispose() {
      master.disconnect();
    },
  };
}
