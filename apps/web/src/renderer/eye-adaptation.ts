// Eye adaptation (spec 2026-11-01-eye-adaptation-design.md): meter the finished frame, let the eye's level follow it
// slowly, turn that into a gain and scale the frame's pixels through a 256-entry table. All of it is pure and
// allocation-free per frame, so the renderer can call it once at the end of a pass.
import { luma } from './colour';
import type { Framebuffer } from './framebuffer';

/** Time constant (s) of the eye's level when the frame is brighter than it: eyes take light in quickly. */
export const ADAPT_UP_S = 0.3;
/** Time constant (s) when the frame is darker than the level: adapting to the dark is slower. */
export const ADAPT_DOWN_S = 1.5;
/**
 * The level (0..255) of an ordinary lit spot, where the gain is 1: the median meter reading, 50.3, of `bench:walls`'
 * 176 lamp poses drawn as 'both + glow' (2026-11-01, D32).
 */
export const REFERENCE = 50;
/** The gain only adapts this share of the way (in the exponent), as eyes do; 1 would flatten every room. */
const STRENGTH = 0.5;
/** Below this the lowest dark shades fall apart into bands. */
export const GAIN_MIN = 0.6;
/** Past this the few dark shades show as bands. */
export const GAIN_MAX = 2.5;
/**
 * The table is only rebuilt when the gain moved by more than this, which is below what the eye tells apart; a gain
 * this close to 1 skips the pass. That is a frame metered within about 2% of REFERENCE (49 to 51), which draws
 * exactly as before adaptation.
 */
const GAIN_STEP = 0.01;

/** Every this-many columns of every this-many rows is metered: about one pixel in 64. */
const SAMPLE_STRIDE_PX = 8;
/** How much weight the frame's corners keep against its centre. */
const EDGE_WEIGHT = 0.25;

/**
 * The frame's centre-weighted log-mean luma (0..255). The log makes a bright area count for less than its share, as
 * it does for an eye. It works on the encoded channels, not linear light: that isn't what the eye meters, but it is
 * what the screen shows, and the reference is measured on the same scale.
 */
export function meterFrame(fb: Framebuffer): number {
  const { pixels, width, height } = fb;
  const halfW = width / 2;
  const halfH = height / 2;
  let weightedLogSum = 0;
  let weightSum = 0;
  for (let y = 0; y < height; y += SAMPLE_STRIDE_PX) {
    const ny = (y + 0.5 - halfH) / halfH;
    for (let x = 0; x < width; x += SAMPLE_STRIDE_PX) {
      const nx = (x + 0.5 - halfW) / halfW;
      const weight = 1 - (1 - EDGE_WEIGHT) * ((nx * nx + ny * ny) / 2);
      const c = pixels[y * width + x] as number;
      weightedLogSum += weight * Math.log(1 + luma(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff));
      weightSum += weight;
    }
  }
  return weightSum === 0 ? 0 : Math.exp(weightedLogSum / weightSum) - 1;
}

/** What the eye is adjusted to: a metered level (0..255), or `null` before the first reading. */
export interface Eye {
  level: number | null;
}

export function createEye(): Eye {
  return { level: null };
}

/** Moves the eye's level towards a reading, exponentially and by real time, so the frame rate doesn't matter. */
export function adaptEye(eye: Eye, reading: number, dtS: number): void {
  // Negated so NaN fails as well as negatives: one NaN reaching the level would stay there for good.
  if (!(reading >= 0)) {
    return;
  }
  if (eye.level === null) {
    eye.level = reading;
    return;
  }
  if (!(dtS > 0)) {
    return;
  }
  const timeConstantS = reading > eye.level ? ADAPT_UP_S : ADAPT_DOWN_S;
  eye.level += (reading - eye.level) * (1 - Math.exp(-dtS / timeConstantS));
}

/** The gain that brings a frame metered at `level` part of the way to the reference. 1 before the first reading. */
export function eyeGain(level: number | null): number {
  if (level === null) {
    return 1;
  }
  const gain = (REFERENCE / Math.max(level, 1e-6)) ** STRENGTH;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, gain));
}

export interface Exposure {
  /** Scales every pixel's colour channels by `gain`, clamped at 255, keeping alpha; a gain near 1 changes nothing. */
  apply(fb: Framebuffer, gain: number): void;
}

export function createExposure(): Exposure {
  const table = new Uint8Array(256);
  let tableGain = Number.NaN;
  return {
    apply(fb, gain) {
      if (Math.abs(gain - 1) <= GAIN_STEP) {
        return;
      }
      if (!(Math.abs(gain - tableGain) <= GAIN_STEP)) {
        for (let v = 0; v < 256; v++) {
          table[v] = Math.min(255, Math.round(v * gain));
        }
        tableGain = gain;
      }
      const { pixels } = fb;
      for (let i = 0; i < pixels.length; i++) {
        const c = pixels[i] as number;
        pixels[i] =
          ((c & 0xff000000) |
            ((table[(c >>> 16) & 0xff] as number) << 16) |
            ((table[(c >>> 8) & 0xff] as number) << 8) |
            (table[c & 0xff] as number)) >>>
          0;
      }
    },
  };
}
