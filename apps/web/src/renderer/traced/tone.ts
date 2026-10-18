// Exposure and the tone curve: linear radiance to a packed screen pixel (spec §3.4). Pure; the tables are exported so
// the frame's composite loop can inline the lookups that `shownPixel`, the reference, does.
import { rgb } from '../framebuffer';

export const EXPOSURE = 4;

/** Table entries per unit of exposed brightness. */
export const TONE_STEPS = 64;
/** The tone tables reach this exposed brightness (a lamp is 36 x EXPOSURE = 144, past it). */
const TONE_RANGE = 128;
export const TONE_SIZE = TONE_RANGE * TONE_STEPS;
export const ENCODE_SIZE = 4096;

/** Whitening starts at this exposed brightness, and is full at WHITENING_FULL_AT. */
const WHITENING_STARTS_AT = 3;
const WHITENING_FULL_AT = 30;
/** How far a colour fades towards white at most, as a share. */
const WHITENING_MAX = 0.75;

/**
 * Toning keeps a colour's hue: its brightest channel goes through 1 - e^-x (straight through the darks, easing into
 * white) and the others scale with it, so a warm highlight stays warm instead of every channel clipping to white. Only
 * far past white (a lamp) does it fade towards white, as film and eyes do.
 *
 * TONE_SCALE is (1 - e^-x) / x and TONE_WHITE how far towards white, both by the brightest exposed channel x, at index
 * `(x * TONE_STEPS) | 0`. An entry holds for its whole step, so TONE_SCALE takes its value at the step's upper edge:
 * the toned channel then stays below 1 and indexes ENCODE in range (at the lower edge it overshoots 1 by up to a step
 * where x is past 6, and the lookup falls off the table). The index clamps at TONE_SIZE - 1, and there the scale is
 * 1 / x, not the entry: with the entry, a lamp's red went past ENCODE's end and out as 0, and lamps turned blue.
 */
export const TONE_SCALE = Float32Array.from({ length: TONE_SIZE }, (_, at) => {
  const upperEdge = (at + 1) / TONE_STEPS;
  return (1 - Math.exp(-upperEdge)) / upperEdge;
});
export const TONE_WHITE = Float32Array.from({ length: TONE_SIZE }, (_, at) => {
  const progress = (at / TONE_STEPS - WHITENING_STARTS_AT) / (WHITENING_FULL_AT - WHITENING_STARTS_AT);
  const t = Math.min(1, Math.max(0, progress));
  return WHITENING_MAX * t * t * (3 - 2 * t);
});

/** Linear 0..1 to an sRGB byte, at index `linear * (ENCODE_SIZE - 1)`. */
export const ENCODE = Uint8Array.from({ length: ENCODE_SIZE }, (_, at) => {
  const linear = at / (ENCODE_SIZE - 1);
  return Math.round((linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055) * 255);
});

const TONE_TOP = TONE_SIZE - 1;
const ENCODE_TOP = ENCODE_SIZE - 1;

/** The reference the composite loop's inlined lookups must match: linear radiance (r, g, b) as a packed 0xffBBGGRR. */
export function shownPixel(r: number, g: number, b: number): number {
  const exposedR = r * EXPOSURE;
  const exposedG = g * EXPOSURE;
  const exposedB = b * EXPOSURE;
  const brightest = Math.max(exposedR, exposedG, exposedB);
  // Compared before the table index is made: far past the table, `| 0` would wrap.
  const at = brightest >= TONE_RANGE ? TONE_TOP : Math.max(0, (brightest * TONE_STEPS) | 0);
  const scale = at === TONE_TOP ? 1 / brightest : (TONE_SCALE.at(at) ?? 0);
  const white = TONE_WHITE.at(at) ?? 0;
  const shown = brightest * scale;
  return rgb(
    encode(whitened(exposedR * scale, shown, white)),
    encode(whitened(exposedG * scale, shown, white)),
    encode(whitened(exposedB * scale, shown, white))
  );
}

function whitened(toned: number, shown: number, white: number): number {
  return toned + (shown - toned) * white;
}

function encode(linear: number): number {
  return ENCODE.at(Math.min(ENCODE_TOP, Math.max(0, (linear * ENCODE_TOP) | 0))) ?? 0;
}
