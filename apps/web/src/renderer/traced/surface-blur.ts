// Reflected surfaces blurred by the cone (spec docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §3.3).
// A reflection sample traces one ray to the wall, floor or ceiling it meets; the cone round that ray, which already
// blurs the lamps and people in closed form, blurs the surfaces here: across the reflection buffer, each sample by its
// own cone's width where it lands, along the row and then along the column. Per axis the kernel is a tent with the
// Gaussian's variance, read from running sums of running sums, so a wide cone costs what a narrow one does, and worked
// out every few samples where it is wide, the samples between drawn on lines. It takes in only samples off the same
// surface: the floor with the floor, a wall plane with itself, never the ceiling rows, which reflect nothing.
// Allocation-free.
import type { TracedBuffers } from './buffers';

/** A tent this many deviations to each side has a Gaussian's variance: h² / 6 = 1. */
export const TENT_PER_DEVIATION = Math.sqrt(6);
/** A tent half a sample to each side lies within the sample, so it is the sample itself: none is narrower. */
export const NARROWEST_TENT = 0.5;
/**
 * A tent h samples to each side is worked out at least every h / 4 samples (so every one up to h = 8) and the samples
 * between drawn on a line. For an uncut tent of one width, what it leaves of an edge bends by at most its contrast / h²
 * per sample², so a line over h / 4 samples misses by under 1% of it; where the tents are cut by a run's end or change
 * width the miss is larger. Against tents worked out at every sample over 45 bench poses: 0.55% on average, 4.8% of the
 * frame's brightest value at worst. Working out every sample measured 1.4 ms a frame against 0.8.
 */
const SAMPLES_TAKEN_PER_HALF = 0.25;
/** A tent is also worked out where its width has changed by this share since the last one: a line assumes one. */
const WIDTH_DRIFT = 0.125;
/** The surfaces a sample can reflect off, as `TracedBuffers.surfaceKind` holds them: none (the matte ceiling)... */
export const NO_SURFACE = 0;
/** ...the floor... */
export const FLOOR_SURFACE = 1;
/** ...a wall whose plane is not known (no face), blurred only with others like it... */
export const UNPLACED_WALL_SURFACE = 2;
/** ...or a wall plane: see `wallSurface`. */
const FIRST_WALL_PLANE = 3;
const FACES = 4;
/** What is read past a line's last sample: no surface kind, so the last run ends there. */
const PAST_THE_LINE = -1;

/**
 * A run of samples off one surface (along a row or a column) while it is blurred: its running sums, and theirs, and the
 * samples whose tents are worked out.
 */
export interface BlurLine {
  /** Per sample k, r, g, b summed over the samples before it, k running to the run's length... */
  sums: Float64Array;
  /** ...and those sums summed likewise, each with half its own sample: the integral of the running sum up to k. */
  sumsOfSums: Float64Array;
  /** The samples whose tents are worked out, in order, and each one's half width (samples); the rest lie between. */
  taken: Int32Array;
  takenHalf: Float64Array;
  takenCount: number;
}

/**
 * The surface kind of wall face `face` (FACE_*) on map line `line` (the map column of a west or east face, the map row
 * of a north or south face): every cell's face along one plane is one surface. Each face and line gives its own kind,
 * above the floor's; anything else (NO_FACE, a line off the map) is UNPLACED_WALL_SURFACE, never another's kind.
 */
export function wallSurface(face: number, line: number): number {
  const isPlane = Number.isInteger(face) && face >= 0 && face < FACES && Number.isInteger(line) && line >= 0;
  return isPlane ? FIRST_WALL_PLANE + face + FACES * line : UNPLACED_WALL_SURFACE;
}

/** What blurs runs of up to `samples` samples. */
export function createBlurLine(samples: number): BlurLine {
  return {
    sums: new Float64Array((samples + 1) * 3),
    sumsOfSums: new Float64Array((samples + 1) * 3),
    taken: new Int32Array(samples),
    takenHalf: new Float64Array(samples),
    takenCount: 0,
  };
}

/**
 * Blurs `reflectedSurface` into `blurredSurface`, each sample by a tent as wide as its cone (`tentAcross` along the
 * row, `tentUp` along the column, half widths in samples), among the samples off its own surface (`surfaceKind`).
 */
export function blurReflectedSurfaces(buffers: TracedBuffers): void {
  const { reflectedWidth, reflectedHeight, reflectedSurface, blurredSurface, tentAcross, tentUp } = buffers;
  for (let sampleRow = 0; sampleRow < reflectedHeight; sampleRow++) {
    blurLine(buffers, reflectedSurface, blurredSurface, tentAcross, sampleRow * reflectedWidth, 1, reflectedWidth);
  }
  for (let sampleCol = 0; sampleCol < reflectedWidth; sampleCol++) {
    blurLine(buffers, blurredSurface, blurredSurface, tentUp, sampleCol, reflectedWidth, reflectedHeight);
  }
}

/**
 * The line of `count` samples from sample `first`, `stride` apart, blurred from `from` into `to` (which may be `from`)
 * by a tent `tents` (half widths, samples) wide per sample, run by run of samples off one surface; the ceiling's
 * runs, which reflect nothing, are cleared.
 */
function blurLine(
  buffers: TracedBuffers,
  from: Float32Array,
  to: Float32Array,
  tents: Float32Array,
  first: number,
  stride: number,
  count: number
): void {
  const kinds = buffers.surfaceKind;
  let runStart = 0;
  let runKind = kinds[first] ?? NO_SURFACE;
  for (let k = 1, sample = first + stride; k <= count; k++, sample += stride) {
    const kind = k < count ? (kinds[sample] ?? NO_SURFACE) : PAST_THE_LINE;
    if (kind === runKind) {
      continue;
    }
    const runFirst = first + runStart * stride;
    if (runKind === NO_SURFACE) {
      clearRun(to, runFirst, stride, k - runStart);
    } else {
      blurRun(buffers.blurLine, from, to, tents, runFirst, stride, k - runStart);
    }
    runStart = k;
    runKind = kind;
  }
}

function clearRun(to: Float32Array, first: number, stride: number, count: number): void {
  for (let k = 0, at = first * 3; k < count; k++, at += stride * 3) {
    to[at] = 0;
    to[at + 1] = 0;
    to[at + 2] = 0;
  }
}

/** A run of `count` samples off one surface, from sample `first`, `stride` apart, blurred from `from` into `to`. */
function blurRun(
  line: BlurLine,
  from: Float32Array,
  to: Float32Array,
  tents: Float32Array,
  first: number,
  stride: number,
  count: number
): void {
  sumTwiceAndTake(line, from, tents, first, stride, count);
  tentsInto(line, to, first, stride, count);
}

/**
 * The run's running sums into `line`, and the samples whose tents are to be worked out. Sample k covers k to k + 1
 * along the run, so its light up to a point x (the integral of the run, a step per sample) is `sums` at x's sample
 * plus the share of that sample before x, and the integral of that up to x is `sumsOfSums` there plus a straight part
 * and a square part of that sample. Only a line between two wide tents of about one width stands for the tents
 * between, so a tent is taken at the run's ends; once SAMPLES_TAKEN_PER_HALF of the narrowest of the last one taken,
 * its own and the next one's half width have passed (so a narrow one is taken with both its neighbours); and wherever
 * its width has drifted WIDTH_DRIFT from the last one taken.
 */
function sumTwiceAndTake(
  line: BlurLine,
  from: Float32Array,
  tents: Float32Array,
  first: number,
  stride: number,
  count: number
): void {
  const { sums, sumsOfSums, taken, takenHalf } = line;
  let red = 0;
  let green = 0;
  let blue = 0;
  let redOfSums = 0;
  let greenOfSums = 0;
  let blueOfSums = 0;
  sums[0] = 0;
  sums[1] = 0;
  sums[2] = 0;
  sumsOfSums[0] = 0;
  sumsOfSums[1] = 0;
  sumsOfSums[2] = 0;
  const lastSample = count - 1;
  let takenCount = 0;
  let lastTaken = 0;
  let lastHalf = 0;
  let nextHalf = tents[first] ?? NARROWEST_TENT;
  for (let k = 0, at = first * 3, sum = 3; k < count; k++, at += stride * 3, sum += 3) {
    const sampleRed = from[at] ?? 0;
    const sampleGreen = from[at + 1] ?? 0;
    const sampleBlue = from[at + 2] ?? 0;
    redOfSums += red + sampleRed * 0.5;
    greenOfSums += green + sampleGreen * 0.5;
    blueOfSums += blue + sampleBlue * 0.5;
    red += sampleRed;
    green += sampleGreen;
    blue += sampleBlue;
    sums[sum] = red;
    sums[sum + 1] = green;
    sums[sum + 2] = blue;
    sumsOfSums[sum] = redOfSums;
    sumsOfSums[sum + 1] = greenOfSums;
    sumsOfSums[sum + 2] = blueOfSums;

    const half = nextHalf;
    nextHalf = k < lastSample ? (tents[first + (k + 1) * stride] ?? NARROWEST_TENT) : 0;
    const narrowest = Math.min(lastHalf, half, nextHalf);
    const drift = half > lastHalf ? half - lastHalf : lastHalf - half;
    const isRunEnd = k === 0 || k === lastSample;
    if (isRunEnd || k - lastTaken >= narrowest * SAMPLES_TAKEN_PER_HALF || drift >= lastHalf * WIDTH_DRIFT) {
      taken[takenCount] = k;
      takenHalf[takenCount] = half;
      takenCount++;
      lastTaken = k;
      lastHalf = half;
    }
  }
  line.takenCount = takenCount;
}

/**
 * The taken samples of the run into `to`, each its light under a tent its half width to each side, cut to the run and
 * weighed by what is left of the tent, and the samples between them on lines. With F the run's integral and G the
 * integral of F, a tent h to each side of the middle c, cut by the run's ends to a..b, cutLow = a − (c − h) and
 * cutHigh = (c + h) − b, weighs up to
 *   (G(a) + G(b) − 2 G(c) − cutLow F(a) + cutHigh F(b)) / h   over a weight of   (2h² − cutLow² − cutHigh²) / 2h.
 * Positions are floored by `| 0` (none is negative).
 */
function tentsInto(line: BlurLine, to: Float32Array, first: number, stride: number, count: number): void {
  const { sums, sumsOfSums, taken, takenHalf, takenCount } = line;
  const lastSample = count - 1;
  for (let index = 0; index < takenCount; index++) {
    const k = taken[index] ?? 0;
    const half = takenHalf[index] ?? NARROWEST_TENT;
    const middle = k + 0.5;
    const low = middle - half > 0 ? middle - half : 0;
    const high = middle + half < count ? middle + half : count;
    const cutLow = low - (middle - half);
    const cutHigh = middle + half - high;
    const scale = 2 / (2 * half * half - cutLow * cutLow - cutHigh * cutHigh);
    // Each point as a sample and the share of it before the point.
    const lowSample = low | 0;
    const highSample = high >= count ? lastSample : high | 0;
    const pastLow = low - lowSample;
    const pastHigh = high - highSample;
    const lowAt = lowSample * 3;
    const highAt = highSample * 3;
    const middleAt = k * 3;
    const out = (first + k * stride) * 3;
    for (let channel = 0; channel < 3; channel++) {
      const lowSum = sums[lowAt + channel] ?? 0;
      const lowLight = (sums[lowAt + 3 + channel] ?? 0) - lowSum;
      const highSum = sums[highAt + channel] ?? 0;
      const highLight = (sums[highAt + 3 + channel] ?? 0) - highSum;
      const middleSum = sums[middleAt + channel] ?? 0;
      const middleLight = (sums[middleAt + 3 + channel] ?? 0) - middleSum;
      const integralToLow = lowSum + pastLow * lowLight;
      const integralToHigh = highSum + pastHigh * highLight;
      const twiceToLow = (sumsOfSums[lowAt + channel] ?? 0) + pastLow * (lowSum + 0.5 * pastLow * lowLight);
      const twiceToHigh = (sumsOfSums[highAt + channel] ?? 0) + pastHigh * (highSum + 0.5 * pastHigh * highLight);
      const twiceToMiddle = (sumsOfSums[middleAt + channel] ?? 0) + 0.5 * middleSum + 0.125 * middleLight;
      to[out + channel] =
        (twiceToLow + twiceToHigh - 2 * twiceToMiddle - cutLow * integralToLow + cutHigh * integralToHigh) * scale;
    }
    if (index > 0) {
      fillBetween(to, first, stride, taken[index - 1] ?? 0, k);
    }
  }
}

/** The samples of the run strictly between `from` and `to`, both taken, on a line between them. */
function fillBetween(samples: Float32Array, first: number, stride: number, from: number, to: number): void {
  if (to - from < 2) {
    return;
  }
  const fromAt = (first + from * stride) * 3;
  const toAt = (first + to * stride) * 3;
  const red = samples[fromAt] ?? 0;
  const green = samples[fromAt + 1] ?? 0;
  const blue = samples[fromAt + 2] ?? 0;
  const perSample = 1 / (to - from);
  const redStep = ((samples[toAt] ?? 0) - red) * perSample;
  const greenStep = ((samples[toAt + 1] ?? 0) - green) * perSample;
  const blueStep = ((samples[toAt + 2] ?? 0) - blue) * perSample;
  for (let k = 1, at = fromAt + stride * 3; k < to - from; k++, at += stride * 3) {
    samples[at] = red + redStep * k;
    samples[at + 1] = green + greenStep * k;
    samples[at + 2] = blue + blueStep * k;
  }
}
