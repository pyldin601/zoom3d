// Frame-time benchmark for renderSprites in a real bundle (`pnpm bench:sprites`), like bench/walls.ts. LEVEL1 at
// 640×360, from seeded poses near lamps, each with 7 avatars in view (faces and flat discs, speaking, bobbing, held
// drinks mid-sip or raised, boomboxes) and the robot vacuum among them, unlit and lit. Only renderSprites is timed; the
// walls under it are redrawn untimed before every frame.
// It also prints a hash of every pixel drawn and every sprite's facts: a refactor that changes no behaviour must leave
// it alone (docs/code-style.md, Refactoring).
import { HELD_ITEMS, type HeldItem, LEVEL1, parseMap, tileAt } from '@zoom3d/shared';
import { FACE_SIZE } from '../src/media/faces';
import type { PeerFacts } from '../src/media/interest';
import { createFramebuffer, rgb } from '../src/renderer/framebuffer';
import type { Glow } from '../src/renderer/glow';
import { bakeLighting, corridorLights } from '../src/renderer/lighting';
import { BALL_MODEL } from '../src/renderer/models/ball';
import { VACUUM_MODEL } from '../src/renderer/models/vacuum';
import { type PeopleAndObjects, renderSprites, type Sprite } from '../src/renderer/sprites';
import { averageColour, makeTextures } from '../src/renderer/textures';
import type { VoxelInstance } from '../src/renderer/voxels';
import { CEILING, FLOOR, type Room, renderWalls } from '../src/renderer/walls';

/** Frames per mode per round, as multiples of the pose count, and rounds (the median is reported). */
const FRAMES_PER_POSE = 4;
const ROUNDS = 7;
const AVATARS = 7;
const MODES = ['unlit', 'lit'] as const;
type Mode = (typeof MODES)[number];
interface Scene {
  x: number;
  y: number;
  angle: number;
  sprites: Sprite[];
  voxels: VoxelInstance[];
  glows: Glow[];
}

const map = parseMap(LEVEL1);
const lights = corridorLights(map);
const textures = makeTextures(1);
const bounce = { wallColours: textures.map((t) => (t.length ? averageColour(t) : 0)), strength: 3.5 };
const lighting = bakeLighting(map, lights, 0.08, FLOOR, CEILING, bounce);
const fb = createFramebuffer(640, 360);
const faces = [faceTexture(0), faceTexture(1)];
const scenes = scenesNearLamps();
const facts = new Map<string, PeerFacts>();
/** What every frame draws, refilled per frame: a new object per frame would count in the timings. */
const room: Room = { map, textures, eye: { x: 0, y: 0, angle: 0 }, lighting: null };
const inRoom: PeopleAndObjects = { eye: room.eye, people: [], objects: [], lighting: null };
/** A float's exact bits, for hashing the facts' disc sizes. */
const bits = new Float64Array(1);
const words = new Int32Array(bits.buffer);

/** Whether renderWalls is handed the scene's people and objects (shadows, floor images): hashed frames and timings do. */
let wallsShowObjects = true;
let hash = 0;
/** What the hashed frames show, so a reader can tell the bench draws something. */
let seen = 0;
let held = 0;
for (const mode of MODES) {
  for (const scene of scenes) {
    drawWalls(mode, scene);
    drawSprites(mode, scene);
    for (const c of fb.pixels) {
      hash = (Math.imul(hash, 31) + c) | 0;
    }
    for (const s of scene.sprites) {
      const f = facts.get(s.key);
      hash = (Math.imul(hash, 31) + (f?.drawnColumns ?? -1)) | 0;
      if (f && f.drawnColumns > 0) {
        seen++;
        held += s.held ? 1 : 0;
      }
      bits[0] = f?.projectedSize ?? -1;
      for (const w of words) {
        hash = (Math.imul(hash, 31) + w) | 0;
      }
    }
  }
}
for (const mode of MODES) {
  time(mode, 300);
}
const times = new Map<Mode, number[]>(MODES.map((m) => [m, []]));
const wallTimes = { without: [] as number[], with: [] as number[] };
for (let round = 0; round < ROUNDS; round++) {
  for (const mode of MODES) {
    times.get(mode)?.push(time(mode, scenes.length * FRAMES_PER_POSE));
  }
  for (const objects of ['without', 'with'] as const) {
    wallsShowObjects = objects === 'with';
    wallTimes[objects].push(timeWalls('lit', scenes.length * FRAMES_PER_POSE));
  }
}
const avatars = scenes.reduce((n, s) => n + s.sprites.length, 0);
const vacuums = scenes.reduce((n, s) => n + s.voxels.filter((v) => v.model === VACUUM_MODEL).length, 0);
const balls = scenes.reduce((n, s) => n + s.voxels.filter((v) => v.model === BALL_MODEL).length, 0);
console.log(
  `LEVEL1, ${scenes.length} poses, ${avatars} avatars (${seen / 2} seen, ${held / 2} of those holding a drink)`
);
console.log(`and ${vacuums} vacuums and ${balls} balls, 640×360`);
console.log(`sprite hash ${hash}`);
for (const mode of MODES) {
  console.log(`${mode.padEnd(6)} ${(median(times.get(mode) ?? []) * 1000).toFixed(1)} µs/frame (renderSprites only)`);
}
for (const objects of ['without', 'with'] as const) {
  console.log(`lit renderWalls ${objects} objects ${(median(wallTimes[objects]) * 1000).toFixed(1)} µs/frame`);
}

function drawWalls(mode: Mode, s: Scene): void {
  room.eye = s;
  room.lighting = mode === 'lit' ? lighting : null;
  room.objects = wallsShowObjects ? s.voxels : [];
  room.people = wallsShowObjects ? s.sprites : [];
  renderWalls(fb, room, s.glows);
}

function drawSprites(mode: Mode, s: Scene): void {
  inRoom.eye = s;
  inRoom.people = s.sprites;
  inRoom.objects = s.voxels;
  inRoom.lighting = mode === 'lit' ? lighting : null;
  renderSprites(fb, inRoom, facts);
}

/** Mean ms per renderSprites call over `frames` frames, cycling through the scenes. */
function time(mode: Mode, frames: number): number {
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const scene = scenes.at(f % scenes.length);
    if (scene) {
      drawWalls(mode, scene);
      const start = performance.now();
      drawSprites(mode, scene);
      total += performance.now() - start;
    }
  }
  return total / frames;
}

/** Mean ms per renderWalls call over `frames` frames, cycling through the scenes: what the objects' shadows cost. */
function timeWalls(mode: Mode, frames: number): number {
  const start = performance.now();
  for (let f = 0; f < frames; f++) {
    const scene = scenes.at(f % scenes.length);
    if (scene) {
      drawWalls(mode, scene);
    }
  }
  return (performance.now() - start) / frames;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.at(sorted.length >> 1) ?? Number.NaN;
}

/** A camera face: a seeded colour gradient with a darker band, FACE_SIZE² texels. */
function faceTexture(seed: number): Uint32Array {
  const texels = new Uint32Array(FACE_SIZE * FACE_SIZE);
  for (let v = 0; v < FACE_SIZE; v++) {
    for (let u = 0; u < FACE_SIZE; u++) {
      const band = Math.abs(v - FACE_SIZE * 0.6) < FACE_SIZE * 0.05 ? 0.5 : 1;
      texels[v * FACE_SIZE + u] = rgb(
        ((u + seed * 80) & 0xff) * band,
        ((v + seed * 40) & 0xff) * band,
        ((u ^ v) & 0xff) * band
      );
    }
  }
  return texels;
}

/**
 * Up to 4 seeded poses within 2.5 tiles of each lamp, each with AVATARS avatars and the vacuum on open floor in front
 * (some hidden by walls, some overlapping), and every avatar's glow plus yours for the lit walls.
 */
function scenesNearLamps(): Scene[] {
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const open = (x: number, y: number) => tileAt(map, Math.floor(x), Math.floor(y)) === 0;
  const colours = [rgb(0xe0, 0x40, 0x40), rgb(0x40, 0xa0, 0xe0), rgb(0x60, 0xc0, 0x60), rgb(0xd0, 0xb0, 0x30)];
  const out: Scene[] = [];
  for (const l of lights) {
    for (let k = 0; k < 4; k++) {
      const x = l.x + (rand() - 0.5) * 5;
      const y = l.y + (rand() - 0.5) * 5;
      if (!open(x, y)) {
        continue;
      }
      const angle = rand() * Math.PI * 2;
      // Somewhere in front: up to 0.7 rad either side of the view, 0.6 to 4 tiles away.
      const ahead = (near: number) => {
        const a = angle + (rand() - 0.5) * 1.4;
        const d = near + rand() * (4 - near);
        return { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d };
      };
      const sprites: Sprite[] = [];
      const glows: Glow[] = [];
      for (let j = 0; j < AVATARS; j++) {
        const at = ahead(0.8);
        if (!open(at.x, at.y)) {
          continue;
        }
        const held: HeldItem | null = HELD_ITEMS.at(j % (HELD_ITEMS.length + 1)) ?? null;
        const lift = rand();
        const raised = j % 3 === 1;
        sprites.push({
          key: `p${j}`,
          x: at.x,
          y: at.y,
          color: colours.at(j % colours.length) ?? 0,
          face: j % 4 === 3 ? null : (faces.at(j % 2) ?? null),
          speaking: j % 2 === 0 ? rand() : 0,
          bob: rand(),
          itemBob: rand(),
          sip: raised ? 0 : lift,
          cheers: raised ? lift : 0,
          wobble: raised ? (rand() - 0.5) * 2 * lift : 0,
          held,
          boombox: j % 3 === 0,
        });
        glows.push({ x: at.x, y: at.y, r: rand() * 0.6, g: rand() * 0.6, b: rand() * 0.6 });
      }
      glows.push({ x, y, r: 0.3, g: 0.25, b: 0.2 });
      const spot = ahead(0.6);
      const voxels = open(spot.x, spot.y) ? [{ model: VACUUM_MODEL, x: spot.x, y: spot.y, angle: rand() * 7 }] : [];
      // Straight ahead, so the seeded poses (and the hash of everything else) stay as they were.
      const kick = { x: x + Math.cos(angle) * 1.2, y: y + Math.sin(angle) * 1.2 };
      if (open(kick.x, kick.y)) {
        voxels.push({ model: BALL_MODEL, x: kick.x, y: kick.y, angle: 0 });
      }
      out.push({ x, y, angle, sprites, voxels, glows });
    }
  }
  return out;
}
