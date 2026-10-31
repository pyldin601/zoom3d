// The lighter's sounds (lighter spec §3.5), synthesised: lit, its lid clicks open, the flint rasps and the flame
// catches; put away, the lid snaps shut. The ball's tone recipe, plus a burst of filtered noise for the strike.

/** Master level: like the ball's, so even a lighter lit right beside the listener stays well under a voice. */
export const LIGHTER_GAIN = 0.15;

interface Tone {
  hz: number;
  peak: number;
  /** Time constant of the decay. */
  decayTauS: number;
}

/** Thin brass partials ring when the lid opens; it closes on a duller, lower clack. */
export const LIGHTER_TONES: Record<'open' | 'close', readonly Tone[]> = {
  open: [
    { hz: 2800, peak: 0.5, decayTauS: 0.03 },
    { hz: 4100, peak: 0.3, decayTauS: 0.02 },
    { hz: 6300, peak: 0.15, decayTauS: 0.012 },
  ],
  close: [
    { hz: 1200, peak: 0.6, decayTauS: 0.02 },
    { hz: 2400, peak: 0.25, decayTauS: 0.01 },
  ],
};
/** The strike comes this long after the lid, as a thumb rolls from the lid to the wheel. */
const STRIKE_DELAY_S = 0.12;
/** The strike: noise through a band-pass round the flint's rasp, then a softer low rush as the flame catches. */
const STRIKE = { hz: 3500, q: 1.2, peak: 0.6, decayTauS: 0.04, lengthS: 0.25 };
const CATCH = { hz: 600, peak: 0.25, riseS: 0.05, decayTauS: 0.12 };
/** Every tone rises this fast, so it doesn't click. */
const ATTACK_S = 0.003;
/** A tone's oscillator runs this long, by when its decay has faded out. */
const TONE_S = 0.25;

export interface LighterSound {
  output: AudioNode;
  /** The lighter is lit. */
  on(): void;
  /** The lighter is put away. */
  off(): void;
  dispose(): void;
}

export function createLighterSound(ctx: BaseAudioContext): LighterSound {
  const master = ctx.createGain();
  master.gain.value = LIGHTER_GAIN;
  // One second of noise, made once: each strike plays the first quarter of it.
  let noise: AudioBuffer | null = null;
  const noiseBuffer = () => {
    if (!noise) {
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.random() * 2 - 1;
      }
    }
    return noise;
  };

  const ring = (tones: readonly Tone[], start: number) => {
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

  const strike = (start: number) => {
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer();
    const rasp = ctx.createBiquadFilter();
    rasp.type = 'bandpass';
    rasp.frequency.value = STRIKE.hz;
    rasp.Q.value = STRIKE.q;
    const raspEnv = ctx.createGain();
    raspEnv.gain.setValueAtTime(0, start);
    raspEnv.gain.linearRampToValueAtTime(STRIKE.peak, start + ATTACK_S);
    raspEnv.gain.setTargetAtTime(0, start + ATTACK_S, STRIKE.decayTauS);
    const flame = ctx.createBiquadFilter();
    flame.type = 'lowpass';
    flame.frequency.value = CATCH.hz;
    const flameEnv = ctx.createGain();
    flameEnv.gain.setValueAtTime(0, start);
    flameEnv.gain.linearRampToValueAtTime(CATCH.peak, start + CATCH.riseS);
    flameEnv.gain.setTargetAtTime(0, start + CATCH.riseS, CATCH.decayTauS);
    source.connect(rasp).connect(raspEnv).connect(master);
    source.connect(flame).connect(flameEnv).connect(master);
    source.start(start);
    source.stop(start + STRIKE.lengthS);
    source.onended = () => {
      raspEnv.disconnect();
      flameEnv.disconnect();
    };
  };

  return {
    output: master,
    on() {
      const start = ctx.currentTime;
      ring(LIGHTER_TONES.open, start);
      strike(start + STRIKE_DELAY_S);
    },
    off() {
      ring(LIGHTER_TONES.close, ctx.currentTime);
    },
    dispose() {
      master.disconnect();
    },
  };
}
