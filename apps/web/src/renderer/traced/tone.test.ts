import { describe, expect, test } from 'vitest';
import { ENCODE, ENCODE_SIZE, EXPOSURE, shownPixel, TONE_SCALE, TONE_SIZE, TONE_STEPS, TONE_WHITE } from './tone';
import { LAMP_RADIANCE } from './world';

const OPAQUE_BLACK = 0xff000000;

function entry(table: Float32Array | Uint8Array, at: number): number {
  const value = table.at(at);
  if (value === undefined) {
    throw new Error(`no table entry at ${at}`);
  }
  return value;
}

function redOf(pixel: number): number {
  return pixel & 0xff;
}

function greenOf(pixel: number): number {
  return (pixel >>> 8) & 0xff;
}

function blueOf(pixel: number): number {
  return (pixel >>> 16) & 0xff;
}

function alphaOf(pixel: number): number {
  return pixel >>> 24;
}

describe('shownPixel', () => {
  test('no light is opaque black', () => {
    expect(shownPixel(0, 0, 0)).toBe(OPAQUE_BLACK);
  });

  test('every pixel is opaque', () => {
    for (const light of [0, 0.01, 1, 36, 1e6]) {
      expect(alphaOf(shownPixel(light, light / 2, light / 4))).toBe(0xff);
    }
  });

  test.each([0.001, 0.05, 0.3, 1, 10, 500])('grey light of %f gives equal bytes', (light) => {
    const pixel = shownPixel(light, light, light);
    expect(greenOf(pixel)).toBe(redOf(pixel));
    expect(blueOf(pixel)).toBe(redOf(pixel));
  });

  test('a dim warm light stays warm: red over green over no blue, and not white', () => {
    const pixel = shownPixel(0.1, 0.05, 0);
    expect(redOf(pixel)).toBeGreaterThan(greenOf(pixel));
    expect(greenOf(pixel)).toBeGreaterThan(blueOf(pixel));
    expect(blueOf(pixel)).toBe(0);
    expect(redOf(pixel)).toBeLessThan(255);
  });

  test('a lamp shows red full, its green and blue fading towards white but never above red', () => {
    // Regression: past the tone table the scale was lost and lamps turned blue.
    const pixel = shownPixel(LAMP_RADIANCE, LAMP_RADIANCE * 0.84 ** 2.2, LAMP_RADIANCE * 0.6 ** 2.2);
    expect(redOf(pixel)).toBe(255);
    expect(redOf(pixel)).toBeGreaterThanOrEqual(greenOf(pixel));
    expect(greenOf(pixel)).toBeGreaterThanOrEqual(blueOf(pixel));
    expect(blueOf(pixel)).toBeGreaterThan(0);
  });

  test('light far past the table is finite, with its brightest channels full and the rest fading to white', () => {
    const pixel = shownPixel(1e6, 1e6, 0);
    expect(Number.isFinite(pixel)).toBe(true);
    expect(redOf(pixel)).toBe(255);
    expect(greenOf(pixel)).toBe(255);
    expect(blueOf(pixel)).toBeGreaterThan(0);
    expect(blueOf(pixel)).toBeLessThan(255);
  });

  /** The byte a grey light of this radiance would have if the curve were computed exactly, not from tables. */
  function exactGreyByte(light: number): number {
    const toned = 1 - Math.exp(-light * EXPOSURE);
    return Math.round((toned <= 0.0031308 ? toned * 12.92 : 1.055 * toned ** (1 / 2.4) - 0.055) * 255);
  }

  test('grey light follows 1 - e^-x, exposed by 4 and sRGB encoded, to within a byte', () => {
    for (let light = 0; light <= 40; light += 0.0007) {
      const red = redOf(shownPixel(light, light, light));
      expect(Math.abs(red - exactGreyByte(light))).toBeLessThanOrEqual(1);
    }
  });

  test('brighter grey never gives a darker byte, one table step apart', () => {
    const lightPerStep = 1 / (TONE_STEPS * EXPOSURE);
    let previous = 0;
    for (let step = 0; step < TONE_SIZE; step++) {
      const red = redOf(shownPixel(step * lightPerStep, step * lightPerStep, step * lightPerStep));
      expect(red).toBeGreaterThanOrEqual(previous);
      previous = red;
    }
  });

  test('brighter grey gives a darker byte by no more than one, where a table step changes', () => {
    // A step's scale is constant, so at its edge the toned value steps back by a little: 1 byte at most.
    let previous = 0;
    let darkest = 0;
    for (let light = 0; light <= 60; light += 0.0005) {
      const red = redOf(shownPixel(light, light, light));
      darkest = Math.max(darkest, previous - red);
      previous = red;
    }
    expect(darkest).toBeLessThanOrEqual(1);
    expect(previous).toBe(255);
  });

  test('exposure is 4', () => {
    expect(EXPOSURE).toBe(4);
  });
});

describe('the tone tables the composite loop reads', () => {
  test('they have the sizes their constants say', () => {
    expect(TONE_SCALE.length).toBe(TONE_SIZE);
    expect(TONE_WHITE.length).toBe(TONE_SIZE);
    expect(ENCODE.length).toBe(ENCODE_SIZE);
  });

  test('the scale is (1 - e^-x) / x at the upper edge of its table step', () => {
    for (const at of [0, 1, 50, 640, 4000, TONE_SIZE - 1]) {
      const x = (at + 1) / TONE_STEPS;
      expect(entry(TONE_SCALE, at)).toBeCloseTo((1 - Math.exp(-x)) / x, 6);
    }
  });

  test('the scale never rises with brightness', () => {
    for (let at = 1; at < TONE_SIZE; at++) {
      expect(entry(TONE_SCALE, at)).toBeLessThanOrEqual(entry(TONE_SCALE, at - 1));
    }
  });

  test('whitening is nothing below x 3, 0.75 from x 30 on, and never falls', () => {
    expect(entry(TONE_WHITE, 3 * TONE_STEPS)).toBe(0);
    expect(entry(TONE_WHITE, 30 * TONE_STEPS)).toBeCloseTo(0.75, 6);
    expect(entry(TONE_WHITE, TONE_SIZE - 1)).toBeCloseTo(0.75, 6);
    for (let at = 1; at < TONE_SIZE; at++) {
      expect(entry(TONE_WHITE, at)).toBeGreaterThanOrEqual(entry(TONE_WHITE, at - 1));
    }
  });

  test('encoding takes black to 0 and full light to 255 and never falls', () => {
    expect(entry(ENCODE, 0)).toBe(0);
    expect(entry(ENCODE, ENCODE_SIZE - 1)).toBe(255);
    for (let at = 1; at < ENCODE_SIZE; at++) {
      expect(entry(ENCODE, at)).toBeGreaterThanOrEqual(entry(ENCODE, at - 1));
    }
  });

  test('a toned channel never indexes past the encode table', () => {
    // The composite loop reads ENCODE[(channel * (ENCODE_SIZE - 1)) | 0] with no bounds check.
    for (let at = 0; at < TONE_SIZE - 1; at++) {
      const brightestInBin = (at + 1) / TONE_STEPS;
      const toned = brightestInBin * entry(TONE_SCALE, at);
      expect(Math.floor(toned * (ENCODE_SIZE - 1))).toBeLessThan(ENCODE_SIZE);
    }
  });

  /** What the composite loop does with the tables: the brightest channel picks the scale, the others follow. */
  function shownThroughTables(r: number, g: number, b: number): number {
    const [exposedR, exposedG, exposedB] = [r * EXPOSURE, g * EXPOSURE, b * EXPOSURE];
    const peak = Math.max(exposedR, exposedG, exposedB);
    const top = TONE_SIZE - 1;
    const at = Math.min(top, (peak * TONE_STEPS) | 0);
    const scale = at === top ? 1 / peak : entry(TONE_SCALE, at);
    const white = entry(TONE_WHITE, at);
    const shown = peak * scale;
    const channel = (exposed: number): number => {
      const toned = exposed * scale;
      const whitened = toned + (shown - toned) * white;
      return entry(ENCODE, (whitened * (ENCODE_SIZE - 1)) | 0);
    };
    return (0xff000000 | (channel(exposedB) << 16) | (channel(exposedG) << 8) | channel(exposedR)) >>> 0;
  }

  test.each([
    [0, 0, 0],
    [0.001, 0.002, 0.0005],
    [0.1, 0.05, 0],
    [0.3, 0.2, 0.1],
    [1, 0.84, 0.6],
    [3, 2, 1],
    [LAMP_RADIANCE, LAMP_RADIANCE * 0.84 ** 2.2, LAMP_RADIANCE * 0.6 ** 2.2],
    [31.99, 20, 10],
    [32.01, 20, 10],
    [1e6, 1e6, 0],
  ])('reading them by hand gives what shownPixel gives for %f %f %f', (r, g, b) => {
    expect(shownThroughTables(r, g, b)).toBe(shownPixel(r, g, b));
  });
});
