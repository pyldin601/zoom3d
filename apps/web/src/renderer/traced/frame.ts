// The ray-traced room, drawn in place of renderWalls into the same Framebuffer (spec
// docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §3): walls, floor, ceiling and the lamps, lit from
// the bake. Avatars, objects and labels come after it as ever.
import type { GameMap, PlayerState } from '@zoom3d/shared';
import type { Framebuffer } from '../framebuffer';
import type { Sprite } from '../sprites';
import { createEmptyTracedBuffers, fitTracedBuffers, type TracedBuffers } from './buffers';
import type { TracedLightmaps } from './lightmaps';
import { drawFloorAndCeiling, drawWalls } from './primary';
import { ENCODE, ENCODE_SIZE, EXPOSURE, TONE_SCALE, TONE_SIZE, TONE_STEPS, TONE_WHITE } from './tone';
import type { TracedWorld } from './world';

/** The room's geometry and its baked light: what a traced frame is drawn from. */
export interface TracedLighting {
  world: TracedWorld;
  maps: TracedLightmaps;
}

export interface TracedScene {
  map: GameMap;
  eye: PlayerState;
  /** Seen in the room's reflections; renderSprites draws them over the frame. */
  people: readonly Sprite[];
  traced: TracedLighting;
}

/** The exposed brightness the tone tables reach: past it a pixel is toned by 1 / brightness. */
const TONE_RANGE = TONE_SIZE / TONE_STEPS;
const TONE_TOP = TONE_SIZE - 1;
const ENCODE_TOP = ENCODE_SIZE - 1;

let buffers = createEmptyTracedBuffers();

/** Draws the room into `fb` and fills its z-buffer, as renderWalls does. Writes every pixel. */
export function renderTraced(fb: Framebuffer, scene: TracedScene): void {
  const { world, maps } = scene.traced;
  buffers = fitTracedBuffers(buffers, fb, scene.eye);
  drawWalls(fb, buffers, world, maps);
  drawFloorAndCeiling(buffers, world, maps);
  toneMap(buffers, fb.pixels);
}

/** The buffers the last frame was drawn from, for tests and the bench: nothing in the game reads them. */
export function lastTracedBuffers(): Readonly<TracedBuffers> {
  return buffers;
}

/**
 * Every pixel's linear light as the screen shows it: `shownPixel` (tone.ts) with its table lookups written out. Called
 * per pixel, `shownPixel` took 25 ms a 640×360 frame against 0.75 ms here; it stays the reference the frame test checks
 * this against.
 */
function toneMap(frame: TracedBuffers, pixels: Uint32Array): void {
  const { hdr } = frame;
  for (let pixel = 0; pixel < frame.width * frame.height; pixel++) {
    const red = (hdr[pixel * 3] ?? 0) * EXPOSURE;
    const green = (hdr[pixel * 3 + 1] ?? 0) * EXPOSURE;
    const blue = (hdr[pixel * 3 + 2] ?? 0) * EXPOSURE;
    const brightest = red > green ? (red > blue ? red : blue) : green > blue ? green : blue;
    // Compared before the index is made: far past the table, `| 0` would wrap.
    const at = brightest >= TONE_RANGE ? TONE_TOP : (brightest * TONE_STEPS) | 0;
    // At the table's end the entry is no longer the scale: a lamp's red would go past ENCODE's end (see TONE_SCALE).
    const scale = at === TONE_TOP ? 1 / brightest : (TONE_SCALE[at] ?? 0);
    const white = TONE_WHITE[at] ?? 0;
    const shown = brightest * scale;
    const tonedRed = red * scale;
    const tonedGreen = green * scale;
    const tonedBlue = blue * scale;
    const redByte = ENCODE[((tonedRed + (shown - tonedRed) * white) * ENCODE_TOP) | 0] ?? 0;
    const greenByte = ENCODE[((tonedGreen + (shown - tonedGreen) * white) * ENCODE_TOP) | 0] ?? 0;
    const blueByte = ENCODE[((tonedBlue + (shown - tonedBlue) * white) * ENCODE_TOP) | 0] ?? 0;
    pixels[pixel] = (0xff000000 | (blueByte << 16) | (greenByte << 8) | redByte) >>> 0;
  }
}
