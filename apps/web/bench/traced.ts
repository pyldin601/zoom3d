// Frame-time benchmark for renderTraced in a real bundle (`pnpm bench:traced`), like bench/walls.ts: LEVEL1 with its
// corridor lamps, at 640×360, from the same poses near lamps, and once more with a crowd of 100 avatars spread over
// the whole map. The bake runs as the game runs it (a slice per call), cold, and is timed whole and slice by slice.
// It also prints a hash of every pixel drawn: a refactor that changes no behaviour must leave it alone
// (docs/code-style.md, Refactoring). bench:walls keeps its own hashes and doesn't draw this mode.
import { LEVEL1, parseMap } from '@zoom3d/shared';
import { FACE_SIZE } from '../src/media/faces';
import { createFramebuffer, rgb } from '../src/renderer/framebuffer';
import { corridorLights } from '../src/renderer/lighting';
import type { Sprite } from '../src/renderer/sprites';
import { makeTextures } from '../src/renderer/textures';
import { renderTraced, type TracedLighting, type TracedScene } from '../src/renderer/traced/frame';
import { createTracedRoom } from '../src/renderer/traced/room';
import { crowdGlows, posesNearLamps } from './poses';

/** Frames per mode per round, as multiples of the pose count, and rounds (the median is reported). */
const FRAMES_PER_POSE = 2;
const ROUNDS = 7;
const MODES = ['traced', 'traced + crowd'] as const;
type Mode = (typeof MODES)[number];

const map = parseMap(LEVEL1);
const lights = corridorLights(map);
const textures = makeTextures(1);
const bake = bakeRoom();
const fb = createFramebuffer(640, 360);
const poses = posesNearLamps(map, lights);
const crowd = crowdSprites();
const NO_PEOPLE: readonly Sprite[] = [];
/** The scene every frame draws, re-aimed per frame: a new object per frame would count in the timings. */
const scene: TracedScene = { map, eye: { x: 0, y: 0, angle: 0 }, people: NO_PEOPLE, traced: bake.lighting };

let pixelHash = 0;
for (const mode of MODES) {
  for (const pose of poses) {
    draw(mode, pose);
    for (const c of fb.pixels) {
      pixelHash = (Math.imul(pixelHash, 31) + c) | 0;
    }
  }
}
for (const mode of MODES) {
  time(mode, 300);
}
const times = new Map<Mode, number[]>(MODES.map((m) => [m, []]));
for (let round = 0; round < ROUNDS; round++) {
  for (const mode of MODES) {
    times.get(mode)?.push(time(mode, poses.length * FRAMES_PER_POSE));
  }
}
console.log(`LEVEL1, ${lights.length} lamps, ${poses.length} poses, 640×360`);
console.log(`bake ${bake.totalMs.toFixed(0)} ms cold in ${bake.slices} slices`);
console.log(
  `first slice ${bake.firstSliceMs.toFixed(1)} ms (builds the world), worst after it ${bake.worstLaterSliceMs.toFixed(1)} ms`
);
console.log(`pixel hash ${pixelHash}`);
for (const mode of MODES) {
  console.log(`${mode.padEnd(14)} ${median(times.get(mode) ?? []).toFixed(3)} ms/frame`);
}

/** Bakes LEVEL1 the way the room loop does, a slice per call, timing each. */
function bakeRoom(): {
  lighting: TracedLighting;
  totalMs: number;
  slices: number;
  firstSliceMs: number;
  worstLaterSliceMs: number;
} {
  const room = createTracedRoom(map, textures, true);
  let slices = 0;
  let firstSliceMs = 0;
  let worstLaterSliceMs = 0;
  const start = performance.now();
  for (let lighting = room.lighting(); lighting === null; lighting = room.lighting()) {
    const sliceStart = performance.now();
    room.bake(0);
    const sliceMs = performance.now() - sliceStart;
    if (slices === 0) {
      firstSliceMs = sliceMs;
    } else {
      worstLaterSliceMs = Math.max(worstLaterSliceMs, sliceMs);
    }
    slices++;
  }
  const lighting = room.lighting();
  if (!lighting) {
    throw new Error('the bake finished without lighting');
  }
  return { lighting, totalMs: performance.now() - start, slices, firstSliceMs, worstLaterSliceMs };
}

function draw(mode: Mode, pose: { x: number; y: number; angle: number }): void {
  scene.eye = pose;
  scene.people = mode === 'traced + crowd' ? crowd : NO_PEOPLE;
  renderTraced(fb, scene);
}

/** Mean ms per frame over `frames` frames, cycling through the poses. */
function time(mode: Mode, frames: number): number {
  const start = performance.now();
  for (let f = 0; f < frames; f++) {
    const pose = poses.at(f % poses.length);
    if (pose) {
      draw(mode, pose);
    }
  }
  return (performance.now() - start) / frames;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.at(sorted.length >> 1) ?? Number.NaN;
}

/** The crowd of bench:walls as avatars: half show a camera face, half a flat ring. */
function crowdSprites(): Sprite[] {
  const face = faceTexture();
  return crowdGlows(map).map(({ x, y, r, g, b }, index) => ({
    key: `p${index}`,
    x,
    y,
    color: rgb(r * 255, g * 255, b * 255),
    face: index % 2 === 0 ? face : null,
    speaking: 0,
    bob: 0,
    itemBob: 0,
    sip: 0,
    cheers: 0,
    wobble: 0,
    held: null,
    boombox: false,
  }));
}

/** A camera face: a colour gradient, FACE_SIZE² texels. */
function faceTexture(): Uint32Array {
  const texels = new Uint32Array(FACE_SIZE * FACE_SIZE);
  for (let v = 0; v < FACE_SIZE; v++) {
    for (let u = 0; u < FACE_SIZE; u++) {
      texels[v * FACE_SIZE + u] = rgb(u & 0xff, v & 0xff, (u ^ v) & 0xff);
    }
  }
  return texels;
}
