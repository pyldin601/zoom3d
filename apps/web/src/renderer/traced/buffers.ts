// What a traced frame is drawn into and from: buffers sized to the frame, and the view its passes project with. They are
// rebuilt only when the frame's size or FOV changes, so a frame allocates nothing.
import type { PlayerState } from '@zoom3d/shared';
import { createView, EYE_HEIGHT, setView, type View } from '../camera';
import type { Framebuffer } from '../framebuffer';
import { fresnel } from './optics';
import { FLOOR_MATERIAL } from './world';

/**
 * A frame of odd height has a row on the horizon, whose floor is infinitely far; it is shown as the floor half a row
 * from the horizon instead.
 */
const MIN_ROWS_FROM_HORIZON = 0.5;

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
