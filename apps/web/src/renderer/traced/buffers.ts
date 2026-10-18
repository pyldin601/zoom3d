// What a traced frame is drawn into and from: buffers sized to the frame, and the view its passes project with. They are
// rebuilt only when the frame's size or FOV changes, so a frame allocates nothing.
import type { PlayerState } from '@zoom3d/shared';
import { createView, EYE_HEIGHT, setView, type View } from '../camera';
import type { Framebuffer } from '../framebuffer';
import { fresnel } from './optics';
import { type BlurLine, createBlurLine } from './surface-blur';
import { FLOOR_MATERIAL } from './world';

/**
 * A frame of odd height has a row on the horizon, whose floor is infinitely far; it is shown as the floor half a row
 * from the horizon instead.
 */
const MIN_ROWS_FROM_HORIZON = 0.5;

/**
 * Reflections are traced at 1/REFLECTION_SCALE of the frame's resolution each way and blended up (spec §3.3, §4): ½
 * everywhere, ¼ only as the phone fallback.
 */
export const REFLECTION_SCALE = 2;
/** A reflection sample is traced for the frame pixel this far into its REFLECTION_SCALE block, each way: the middle. */
export const REFLECTION_SAMPLE_OFFSET = REFLECTION_SCALE >> 1;

/** How each frame row (or column) blends the two reflection samples either side of it. */
export interface SampleBlend {
  /** Per frame row or column, the reflection sample before it; the next one is the one after. */
  before: Int32Array;
  /** How far on from `before` towards the next sample, 0..1. */
  towardsNext: Float32Array;
}

export interface TracedBuffers {
  width: number;
  height: number;
  fov: number;
  /** The camera for the frame being drawn: aimed by `fitTracedBuffers` each frame. */
  view: View;
  /** Linear light per pixel, r, g, b interleaved, before exposure and tone. */
  hdr: Float32Array;
  /** Per pixel, the Fresnel weight of what reflects there (0..1): how much of it is a reflection, 0 where none shows. */
  spec: Float32Array;
  /** Per pixel, the tile id whose material reflects there (0 the floor), for the reflection's tint. */
  specTile: Uint8Array;
  /** Per pixel, the floor's Fresnel weight if it shows the floor there: it depends only on where the pixel is. */
  floorFresnel: Float32Array;
  /** Per screen row, the perpendicular distance in tiles to the floor or ceiling it shows. */
  rowDistance: Float64Array;
  /** Per screen column, the rows its wall covers, [start, end); equal where it shows none. */
  wallStart: Int32Array;
  wallEnd: Int32Array;
  /** Per screen column, how far its wall is (perpendicular to the camera plane, tiles); Infinity where none is in reach. */
  wallDistance: Float64Array;
  /** The reflection samples across and down: the frame's size over REFLECTION_SCALE. */
  reflectedWidth: number;
  reflectedHeight: number;
  /**
   * What each reflection sample's cone meets, linear r, g, b interleaved, row by row: what the people leave of its
   * surfaces, blurred, plus the lamps and people over them.
   */
  reflected: Float32Array;
  /** Per sample, the walls, floor and ceiling its cone meets, r, g, b, before it blurs them (surface-blur.ts)... */
  reflectedSurface: Float32Array;
  /** ...how much of them the people in front leave showing... */
  reflectedKeep: Float32Array;
  /** ...and the lamps and people over them, r, g, b, already blurred by the cone in closed form. */
  reflectedOver: Float32Array;
  /** Per sample, the surface its cone leaves from (surface-blur.ts: NO_SURFACE, FLOOR_SURFACE or a wall plane). */
  surfaceKind: Int32Array;
  /** Per sample, the cone's deviation where it meets the surfaces, in samples along the row and along the column. */
  coneAcross: Float32Array;
  coneUp: Float32Array;
  /** `reflectedSurface` blurred by the cone, and the line the blur works along. */
  blurredSurface: Float32Array;
  blurLine: BlurLine;
  /** `reflected` blended out to the frame's width, still a row per sample row: the composite blends two of its rows. */
  widenedReflection: Float32Array;
  reflectionColumns: SampleBlend;
  reflectionRows: SampleBlend;
  /** Per reflection column, `wallDistance` at the screen column it is traced for... */
  reflectedWallDistance: Float64Array;
  /** ...and that blended over its neighbours as the floor's cone spreads across them (occlusion.ts). */
  softWallDistance: Float64Array;
}

/** Buffers that fit a frame of no pixels: what is "drawn" before the first frame. */
export function createEmptyTracedBuffers(): TracedBuffers {
  return createTracedBuffers(0, 0, 0);
}

/** `buffers` aimed from `eye`, or new ones if the frame's size or FOV is not the one they were made for. */
export function fitTracedBuffers(buffers: TracedBuffers, fb: Framebuffer, eye: PlayerState): TracedBuffers {
  const fitted =
    buffers.width === fb.width && buffers.height === fb.height && buffers.fov === fb.fov
      ? buffers
      : createTracedBuffers(fb.width, fb.height, fb.fov);
  setView(fitted.view, fb, eye);
  return fitted;
}

function createTracedBuffers(width: number, height: number, fov: number): TracedBuffers {
  const pixels = width * height;
  const planeLength = Math.tan(fov / 2);
  const proj = width / 2 / planeLength;
  const reflectedWidth = Math.floor(width / REFLECTION_SCALE);
  const reflectedHeight = Math.floor(height / REFLECTION_SCALE);
  const samples = reflectedWidth * reflectedHeight;
  return {
    width,
    height,
    fov,
    view: createView(),
    hdr: new Float32Array(pixels * 3),
    spec: new Float32Array(pixels),
    specTile: new Uint8Array(pixels),
    floorFresnel: floorFresnelOf(width, height, planeLength, proj),
    rowDistance: Float64Array.from({ length: height }, (_, row) => rowDistanceOf(row, height, proj)),
    wallStart: new Int32Array(width),
    wallEnd: new Int32Array(width),
    wallDistance: new Float64Array(width),
    reflectedWidth,
    reflectedHeight,
    reflected: new Float32Array(samples * 3),
    reflectedSurface: new Float32Array(samples * 3),
    reflectedKeep: new Float32Array(samples),
    reflectedOver: new Float32Array(samples * 3),
    surfaceKind: new Int32Array(samples),
    coneAcross: new Float32Array(samples),
    coneUp: new Float32Array(samples),
    blurredSurface: new Float32Array(samples * 3),
    blurLine: createBlurLine(Math.max(reflectedWidth, reflectedHeight)),
    widenedReflection: new Float32Array(width * reflectedHeight * 3),
    reflectionColumns: sampleBlendOf(width, reflectedWidth),
    reflectionRows: sampleBlendOf(height, reflectedHeight),
    reflectedWallDistance: new Float64Array(reflectedWidth),
    softWallDistance: new Float64Array(reflectedWidth),
  };
}

function rowDistanceOf(row: number, height: number, proj: number): number {
  return (EYE_HEIGHT * proj) / Math.max(MIN_ROWS_FROM_HORIZON, Math.abs(row + 0.5 - height / 2));
}

/**
 * The floor's Fresnel weight at each pixel below the horizon. A pixel's ray runs through its column's left edge, as the
 * walls' do, and falls `slope` tiles per tile of depth; the floor's normal is straight up.
 */
function floorFresnelOf(width: number, height: number, planeLength: number, proj: number): Float32Array {
  const weights = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const slope = (row + 0.5 - height / 2) / proj;
    if (slope <= 0) {
      continue;
    }
    for (let col = 0; col < width; col++) {
      const across = ((2 * col) / width - 1) * planeLength;
      weights[row * width + col] = fresnel(slope / Math.sqrt(1 + across * across + slope * slope), FLOOR_MATERIAL);
    }
  }
  return weights;
}

/**
 * Sample `n` is traced for frame pixel n · REFLECTION_SCALE + REFLECTION_SAMPLE_OFFSET, so frame pixel `at` lies
 * (at − offset) / scale samples in; beyond the first or last sample it takes that sample.
 */
function sampleBlendOf(frameSize: number, samples: number): SampleBlend {
  const before = new Int32Array(frameSize);
  const towardsNext = new Float32Array(frameSize);
  const lastPair = Math.max(0, samples - 2);
  for (let at = 0; at < frameSize; at++) {
    const position = Math.min(
      Math.max(0, samples - 1),
      Math.max(0, (at - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE)
    );
    const first = Math.min(lastPair, Math.floor(position));
    before[at] = first;
    towardsNext[at] = position - first;
  }
  return { before, towardsNext };
}
