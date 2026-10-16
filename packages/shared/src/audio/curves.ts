// Spatial audio curves and tuning settings (spec §9.2).

export interface AudioSettings {
  /** Full volume within this many tiles. */
  ref: number;
  /** Silent from this many tiles. */
  max: number;
  /** Reverb bus level. */
  reverb: number;
  /** Lowpass cutoff when a wall is between listener and speaker. */
  muffleHz: number;
  /** Gain multiplier when a wall is between listener and speaker. */
  occludedGain: number;
  /** HRTF for headphones, equal-power for speakers. */
  panning: 'HRTF' | 'equalpower';
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  ref: 1.5,
  max: 24,
  reverb: 1,
  muffleHz: 700,
  occludedGain: 0.5,
  panning: 'HRTF',
};

export const MUFFLE_OPEN_HZ = 16000;
export const TAU_POSITION = 0.05;
export const TAU_OCCLUSION = 0.15;
export const OCCLUSION_INTERVAL_MS = 100;

/** Reverb send within `ref`; it falls only 3 dB per doubling, so the room outlasts the voice. */
export const WET_NEAR = 0.4;
/** Both gains fade to silence over the last quarter of the range. */
const FADE_START = 0.75;

/** Direct sound follows 1/d (−6 dB per doubling), reverb 1/√d; both reach 0 at `max`. */
export function voiceGains(distance: number, occluded: boolean, s: AudioSettings): { dry: number; send: number } {
  if (!Number.isFinite(distance)) {
    return { dry: 0, send: 0 };
  }
  const a = s.ref / Math.max(distance, s.ref);
  const start = s.max * FADE_START;
  const f = Math.min(Math.max((distance - start) / (s.max - start), 0), 1);
  const fade = 1 - f * f * (3 - 2 * f);
  const k = (occluded ? s.occludedGain : 1) * fade;
  return { dry: a * k, send: WET_NEAR * Math.sqrt(a) * k };
}
