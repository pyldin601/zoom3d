// Two-tone chime rung when someone joins the room: E5 then C5, like a hallway doorbell.
// Synthesised (no asset) and played straight to the speakers: it's the room's bell, not a sound from a place.

/** Seconds after the ring each bar is struck, and its pitch. */
export const DOORBELL_NOTES: readonly { at: number; hz: number }[] = [
  { at: 0, hz: 659.25 },
  { at: 0.45, hz: 523.25 },
];
/** Rings closer together than this collapse into one, so a burst of arrivals isn't a racket. */
export const DOORBELL_COOLDOWN_S = 2;

const VOLUME = 0.18;
const ATTACK_S = 0.004;
/** A struck bar: the fundamental rings on, the inharmonic overtone (×2.76) gives the strike and dies fast. */
const PARTIALS = [
  { ratio: 1, gain: 1, tau: 0.45 },
  { ratio: 2.76, gain: 0.35, tau: 0.08 },
];
/** About 7 time constants of the longest partial: below −60 dB. */
const RING_S = 3;

export interface Doorbell {
  ring(): void;
}

export function createDoorbell(ctx: BaseAudioContext): Doorbell {
  let lastRing = Number.NEGATIVE_INFINITY;

  const strike = (t: number, hz: number) => {
    for (const p of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz * p.ratio;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(VOLUME * p.gain, t + ATTACK_S);
      env.gain.setTargetAtTime(0, t + ATTACK_S, p.tau);
      osc.connect(env).connect(ctx.destination);
      osc.onended = () => env.disconnect();
      osc.start(t);
      osc.stop(t + RING_S);
    }
  };

  return {
    ring() {
      const t = ctx.currentTime;
      if (t - lastRing < DOORBELL_COOLDOWN_S) {
        return;
      }
      lastRing = t;
      for (const note of DOORBELL_NOTES) {
        strike(t + note.at, note.hz);
      }
    },
  };
}
