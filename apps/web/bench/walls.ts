// Frame-time benchmark for renderWalls in a real bundle (`pnpm bench:walls`): vitest's bench runs transformed
// modules whose timings don't match the shipped build. LEVEL1 with its corridor lamps and bounce light, at 640×360,
// from poses near lamps (where reflections cost most), each with 7 glowing avatars nearby and your own glow, and
// once more with a crowd of 100 glowing avatars spread over the whole map (most of them out of view, as with ?bots).
// It also prints a hash of the baked lighting and of every pixel drawn in every mode: a refactor that changes no
// behaviour must leave both hashes alone (docs/code-style.md, Refactoring).
import { LEVEL1, parseMap, tileAt, wirePortals } from '@zoom3d/shared';
import { createFramebuffer } from '../src/renderer/framebuffer';
import type { Glow } from '../src/renderer/glow';
import { bakeLighting, bakePortalLighting, corridorLights, type Lighting } from '../src/renderer/lighting';
import { averageColour, makeTextures } from '../src/renderer/textures';
import { CEILING, FLOOR, type Room, renderWalls } from '../src/renderer/walls';

/** Frames per mode per round, as multiples of the pose count, and rounds (the median is reported). */
const FRAMES_PER_POSE = 2;
const ROUNDS = 7;
const MODES = ['unlit', 'none', 'walls', 'both', 'both + glow', 'both + crowd', 'only'] as const;
/** Glowing avatars in the crowd mode. */
const CROWD = 100;
type Mode = (typeof MODES)[number];
interface Pose {
  x: number;
  y: number;
  angle: number;
  glows: Glow[];
}

const map = parseMap(LEVEL1);
const lights = corridorLights(map);
const textures = makeTextures(1);
const bounce = { wallColours: textures.map((t) => (t.length ? averageColour(t) : 0)), strength: 3.5 };
const bakeStart = performance.now();
const lighting = bakeLighting(map, lights, 0.08, FLOOR, CEILING, bounce);
const bakeMs = performance.now() - bakeStart;
const fb = createFramebuffer(640, 360);
const poses = posesNearLamps();
const crowd = crowdGlows();
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

// Portals on (portal doorways spec): the same lit frame from 1.5 tiles in front of each of up to 8 doorways, looking in,
// timed with the room's portals off and on, with the hash of the on frames beside the off hashes above.
const portals = wirePortals(map, 'bench-room');
const doorwayPoses: Pose[] = portals.list.slice(0, 8).map((p) => ({
  x: p.cx - p.nx * 1.5,
  y: p.cy - p.ny * 1.5,
  angle: Math.atan2(p.ny, p.nx),
  glows: [],
}));
const portalBakeStart = performance.now();
const portalLighting = bakePortalLighting(lighting, portals, FLOOR, CEILING);
const portalBakeMs = performance.now() - portalBakeStart;
console.log(
  `portal lighting: bake ${portalBakeMs.toFixed(0)} ms (cold); ${portalLighting.lights.length - lights.length} copies ` +
    `of ${lights.length} lamps; lighting hash ${lightingHash(portalLighting)}`
);
room.reflections = 'both';
const portalHashes = { off: 0, on: 0 };
for (const state of ['off', 'on'] as const) {
  room.portals = state === 'on' ? portals : null;
  room.lighting = state === 'on' ? portalLighting : lighting;
  for (const pose of doorwayPoses) {
    room.eye = pose;
    renderWalls(fb, room);
    for (const c of fb.pixels) {
      portalHashes[state] = (Math.imul(portalHashes[state], 31) + c) | 0;
    }
  }
}
const portalTimes = { off: [] as number[], on: [] as number[] };
for (let round = 0; round < ROUNDS; round++) {
  for (const state of ['off', 'on'] as const) {
    room.portals = state === 'on' ? portals : null;
    room.lighting = state === 'on' ? portalLighting : lighting;
    const start = performance.now();
    const frames = doorwayPoses.length * 20;
    for (let f = 0; f < frames; f++) {
      room.eye = doorwayPoses.at(f % doorwayPoses.length) ?? room.eye;
      renderWalls(fb, room);
    }
    portalTimes[state].push((performance.now() - start) / frames);
  }
}
console.log(`portals: ${doorwayPoses.length} doorway poses, pixel hash off ${portalHashes.off}, on ${portalHashes.on}`);
for (const state of ['off', 'on'] as const) {
  console.log(`both, portals ${state.padEnd(3)} ${median(portalTimes[state]).toFixed(3)} ms/frame`);
}

// The crowd with portals on: from the lamp poses (most show no window, so the floor tables need only what is in view)
// and from the doorway poses (whose windows look anywhere), with portals off and on.
const crowdPoses = [...poses, ...doorwayPoses];
const crowdHashes = { off: 0, on: 0 };
for (const state of ['off', 'on'] as const) {
  room.portals = state === 'on' ? portals : null;
  room.lighting = state === 'on' ? portalLighting : lighting;
  for (const pose of crowdPoses) {
    room.eye = pose;
    renderWalls(fb, room, crowd);
    for (const c of fb.pixels) {
      crowdHashes[state] = (Math.imul(crowdHashes[state], 31) + c) | 0;
    }
  }
}
const crowdTimes = { off: [] as number[], on: [] as number[] };
for (let round = 0; round < ROUNDS; round++) {
  for (const state of ['off', 'on'] as const) {
    room.portals = state === 'on' ? portals : null;
    room.lighting = state === 'on' ? portalLighting : lighting;
    const start = performance.now();
    const frames = poses.length * FRAMES_PER_POSE;
    for (let f = 0; f < frames; f++) {
      room.eye = poses.at(f % poses.length) ?? room.eye;
      renderWalls(fb, room, crowd);
    }
    crowdTimes[state].push((performance.now() - start) / frames);
  }
}
console.log(`crowd: ${crowdPoses.length} poses, pixel hash off ${crowdHashes.off}, on ${crowdHashes.on}`);
for (const state of ['off', 'on'] as const) {
  console.log(`both + crowd, portals ${state.padEnd(3)} ${median(crowdTimes[state]).toFixed(3)} ms/frame (lamp poses)`);
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

/** Up to 8 seeded poses within 2.5 tiles of each lamp, facing anywhere, with glowing avatars around them. */
function posesNearLamps(): Pose[] {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const open = (x: number, y: number) => tileAt(map, Math.floor(x), Math.floor(y)) === 0;
  const out: Pose[] = [];
  for (const l of lights) {
    for (let k = 0; k < 8; k++) {
      const x = l.x + (rand() - 0.5) * 5;
      const y = l.y + (rand() - 0.5) * 5;
      if (!open(x, y)) {
        continue;
      }
      const glows: Glow[] = [];
      for (let j = 0; j < 7; j++) {
        const gx = x + (rand() - 0.5) * 4;
        const gy = y + (rand() - 0.5) * 4;
        if (open(gx, gy)) {
          glows.push({ x: gx, y: gy, r: rand() * 0.6, g: rand() * 0.6, b: rand() * 0.6 });
        }
      }
      glows.push({ x, y, r: 0.3, g: 0.25, b: 0.2 });
      out.push({ x, y, angle: rand() * Math.PI * 2, glows });
    }
  }
  return out;
}

/** CROWD seeded glows anywhere open on the map. */
function crowdGlows(): Glow[] {
  let seed = 3;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: Glow[] = [];
  while (out.length < CROWD) {
    const x = rand() * map.width;
    const y = rand() * map.height;
    if (tileAt(map, Math.floor(x), Math.floor(y)) === 0) {
      out.push({ x, y, r: rand() * 0.6, g: rand() * 0.6, b: rand() * 0.6 });
    }
  }
  return out;
}

/** A hash of every baked table, so a bake refactor can show it bakes the same. */
function lightingHash(lm: Lighting): number {
  let hash = 0;
  const tables = [
    lm.faceOffset,
    lm.faceRun,
    lm.wall,
    lm.wallLampSeen,
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
  for (const lampList of [lm.wallLamp, lm.floorLamp]) {
    for (const lamp of lampList) {
      hash = (Math.imul(hash, 31) + lamp) | 0;
    }
    hash = (Math.imul(hash, 31) + lampList.length) | 0;
  }
  return hash;
}
