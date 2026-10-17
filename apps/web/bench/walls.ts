// Frame-time benchmark for renderWalls in a real bundle (`pnpm bench:walls`): vitest's bench runs transformed
// modules whose timings don't match the shipped build. LEVEL1 with its corridor lamps and bounce light, at 640×360,
// from poses near lamps (where reflections cost most), each with 7 glowing avatars nearby and your own glow, and
// once more with a crowd of 100 glowing avatars spread over the whole map (most of them out of view, as with ?bots).
// It also prints a hash of the baked lighting and of every pixel drawn in every mode: a refactor that changes no
// behaviour must leave both hashes alone (docs/code-style.md, Refactoring).
import { LEVEL1, parseMap } from '@zoom3d/shared';
import { createFramebuffer } from '../src/renderer/framebuffer';
import { bakeLighting, corridorLights, type Lighting } from '../src/renderer/lighting';
import { averageColour, makeTextures } from '../src/renderer/textures';
import { CEILING, FLOOR, type Room, renderWalls } from '../src/renderer/walls';
import { crowdGlows, type Pose, posesNearLamps } from './poses';

/** Frames per mode per round, as multiples of the pose count, and rounds (the median is reported). */
const FRAMES_PER_POSE = 2;
const ROUNDS = 7;
const MODES = ['unlit', 'none', 'walls', 'both', 'both + glow', 'both + crowd', 'only'] as const;
type Mode = (typeof MODES)[number];

const map = parseMap(LEVEL1);
const lights = corridorLights(map);
const textures = makeTextures(1);
const bounce = { wallColours: textures.map((t) => (t.length ? averageColour(t) : 0)), strength: 3.5 };
const bakeStart = performance.now();
const lighting = bakeLighting(map, lights, 0.08, FLOOR, CEILING, bounce);
const bakeMs = performance.now() - bakeStart;
const fb = createFramebuffer(640, 360);
const poses = posesNearLamps(map, lights);
const crowd = crowdGlows(map);
/** The room every frame draws, re-aimed and re-lit per frame: a new object per frame would count in the timings. */
const room: Room = { map, textures, eye: { x: 0, y: 0, angle: 0 }, lighting: null };

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
console.log(`bake ${bakeMs.toFixed(0)} ms (cold); lighting hash ${lightingHash(lighting)}; pixel hash ${pixelHash}`);
for (const mode of MODES) {
  console.log(`${mode.padEnd(12)} ${median(times.get(mode) ?? []).toFixed(3)} ms/frame`);
}

function draw(mode: Mode, p: Pose): void {
  room.eye = p;
  room.lighting = mode === 'unlit' ? null : lighting;
  if (mode === 'unlit') {
    renderWalls(fb, room);
  } else if (mode === 'both + glow') {
    room.reflections = 'both';
    renderWalls(fb, room, p.glows);
  } else if (mode === 'both + crowd') {
    room.reflections = 'both';
    renderWalls(fb, room, crowd);
  } else {
    room.reflections = mode;
    renderWalls(fb, room);
  }
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

/** A hash of every baked table, so a bake refactor can show it bakes the same. */
function lightingHash(lm: Lighting): number {
  let hash = 0;
  const tables = [
    lm.faceOffset,
    lm.faceRun,
    lm.wall,
    lm.wallLamp,
    lm.wallLampSeen,
    lm.floorLamp,
    lm.floorLampSeen,
    lm.floor,
    lm.ceiling,
    lm.bounce ?? new Float32Array(0),
  ];
  for (const table of tables) {
    for (const word of new Int32Array(table.buffer, table.byteOffset, table.byteLength >> 2)) {
      hash = (Math.imul(hash, 31) + word) | 0;
    }
    hash = (Math.imul(hash, 31) + table.length) | 0;
  }
  return hash;
}
