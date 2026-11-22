// Slow light's colour shift (D40): each pixel's colour is a spectrum, shifted in wavelength by the Doppler factor D and
// seen through the eye's red, green and blue. The model is linear in RGB, so a shift is a 3×3 matrix, tabulated by D.

/** Doppler factors are tabulated at this many values of ln D, evenly over [MIN_LN_D, MAX_LN_D]: odd, so D = 1 is one. */
export const DOPPLER_STEPS = 257;
/** At the β cap of 0.5, D runs from 0.577 to 1.732. */
export const MIN_LN_D = Math.log(0.5);
export const MAX_LN_D = Math.log(2);

/** The wavelengths (nm) the eye samples for red, green and blue: a colour's three values are its spectrum there. */
const SAMPLE_NM = [610, 540, 450] as const;
/** Below this there is no light: the room has no ultraviolet. */
const UV_EDGE_NM = 400;
/**
 * Warm lamps are rich in infrared, and paints reflect it about as much as light overall: past the red sample the
 * spectrum runs to IR_TAIL times the colour's mean at IR_NM, then fades to nothing at IR_END_NM.
 */
const IR_TAIL = 0.6;
const IR_NM = 700;
const IR_END_NM = 1300;

/** The spectrum at `nm` of a colour that is 1 in channel `j` (0 red, 1 green, 2 blue) and 0 in the others. */
function basis(j: number, nm: number): number {
  const [red, green, blue] = [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0];
  const ir = (IR_TAIL * (red + green + blue)) / 3;
  const nodes: readonly (readonly [number, number])[] = [
    [UV_EDGE_NM, 0],
    [SAMPLE_NM[2], blue],
    [SAMPLE_NM[1], green],
    [SAMPLE_NM[0], red],
    [IR_NM, ir],
    [IR_END_NM, 0],
  ];
  for (let k = 1; k < nodes.length; k++) {
    const [x0, y0] = nodes.at(k - 1) ?? [0, 0];
    const [x1, y1] = nodes.at(k) ?? [0, 0];
    if (nm >= x0 && nm <= x1) {
      return y0 + ((y1 - y0) * (nm - x0)) / (x1 - x0);
    }
  }
  return 0;
}

/**
 * M(D), row-major into `out`: the linear RGB seen, from the linear RGB in the room. Seen at wavelength λ, the light
 * left at λ·D, and spectral radiance per wavelength goes as D⁵. The spectrum is linear in the colour, so this is a
 * matrix; at D = 1 it is the identity.
 */
export function shiftMatrix(d: number, out: Float32Array): Float32Array {
  const gain = d ** 5;
  for (let i = 0; i < 3; i++) {
    const from = (SAMPLE_NM.at(i) ?? 0) * d;
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = gain * basis(j, from);
    }
  }
  return out;
}

/** The table index of Doppler factor `d`, clamped to the table; NaN reads as D = 1. */
export function dopplerIndex(d: number): number {
  const ln = Number.isNaN(d) ? 0 : Math.log(d);
  const i = Math.round(((ln - MIN_LN_D) / (MAX_LN_D - MIN_LN_D)) * (DOPPLER_STEPS - 1));
  return Math.min(DOPPLER_STEPS - 1, Math.max(0, i));
}

/** `DOPPLER_STEPS` matrices of 9, row-major, by `dopplerIndex`. */
export const SHIFT_MATRICES: Float32Array = (() => {
  const table = new Float32Array(DOPPLER_STEPS * 9);
  const one = new Float32Array(9);
  for (let i = 0; i < DOPPLER_STEPS; i++) {
    const d = Math.exp(MIN_LN_D + ((MAX_LN_D - MIN_LN_D) * i) / (DOPPLER_STEPS - 1));
    table.set(shiftMatrix(d, one), i * 9);
  }
  return table;
})();

/** The tone curve's shoulder: light up to here is shown as is, brighter rolls off toward 1. */
const SHOULDER = 0.8;
const SHOULDER_SOFTNESS = 0.2;

export function toneCurve(x: number): number {
  return x <= SHOULDER ? x : SHOULDER + SHOULDER_SOFTNESS * (1 - Math.exp(-(x - SHOULDER) / SHOULDER_SOFTNESS));
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

export const SRGB_TO_LINEAR: Float32Array = Float32Array.from({ length: 256 }, (_, byte) => srgbToLinear(byte / 255));

/**
 * Linear light to a toned sRGB byte by table, with no maths per pixel: a fine table for the dark end, where sRGB is
 * steep, and a coarse one above it. Past MAX_LIGHT the tone curve has reached 1.
 */
const FINE_TO = 1 / 16;
const FINE_PER_UNIT = 65536;
const MAX_LIGHT = 16;
const COARSE_PER_UNIT = 1024;
const encode = (x: number) => Math.round(linearToSrgb(toneCurve(x)) * 255);
const FINE = Uint8Array.from({ length: FINE_TO * FINE_PER_UNIT }, (_, i) => encode((i + 0.5) / FINE_PER_UNIT));
const COARSE = Uint8Array.from({ length: MAX_LIGHT * COARSE_PER_UNIT }, (_, i) => encode((i + 0.5) / COARSE_PER_UNIT));
const BRIGHTEST = encode(MAX_LIGHT);

/** Linear light, through the tone curve, as an sRGB byte. Negative light (a matrix can make it) is black. */
export function linearToSrgbByte(x: number): number {
  if (!(x > 0)) {
    return 0;
  }
  if (x < FINE_TO) {
    return FINE[(x * FINE_PER_UNIT) | 0] as number;
  }
  return x < MAX_LIGHT ? (COARSE[(x * COARSE_PER_UNIT) | 0] as number) : BRIGHTEST;
}
