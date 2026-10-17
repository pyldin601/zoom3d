// Lighting (decision D24): static ceiling lamps baked once per map into lightmaps, so a frame pays one table lookup
// per floor or ceiling pixel and one lookup plus a multiply per wall texel. Shadows are grid-exact and soft: each
// sample asks how much of each lamp's disc it can see (2D lines of sight). Ambient is bounce light, what the lit
// surfaces throw back. The bake also lists, per wall sample column and floor cell, the lamps it can reflect; the
// reflection model itself (`reflection()`) is pure and runs per frame, sampled sparsely by walls.ts.
import { type GameMap, hasLineOfSight, tileAt } from '@zoom3d/shared';
import { EYE_HEIGHT } from './camera';
import { rgb } from './framebuffer';
import { RELIEF_LEVELS, type ReflectionMaterial } from './textures';

export interface Light {
  x: number;
  y: number;
  /** Height above the floor (0..1, the ceiling is 1). */
  z: number;
  /** Reach in tiles: nothing past it is lit. */
  radius: number;
  /** Linear colour × intensity per channel (1 = full brightness at the lamp). */
  r: number;
  g: number;
  b: number;
}

/** Wall face samples: U across the face, V down it (one per 8 texel rows of a 64 texture). */
export const WALL_U = 16;
export const WALL_V = 8;
/** Floor and ceiling samples per tile edge. */
export const FLOOR_SUB = 8;
/** Light multipliers are packed 0xBBGGRR with 128 = 1.0, so a lamp can overbright up to 2×. */
const ONE = 128;
/** Ceiling cells within this distance (tiles) of a lamp show the lamp itself. */
const FIXTURE_RADIUS = 0.18;
/** The colour a lamp's fixture shows on the ceiling. */
const FIXTURE = rgb(255, 236, 190);
/**
 * A lamp casts shadows as a disc this wide (radius, tiles), its fixture's size: a wall's edge hides part of it, so
 * shadows fade in over a few cells instead of stepping.
 */
const LAMP_RADIUS = FIXTURE_RADIUS;
/** Halvings to find where a wall's edge cuts a lamp: its share is then known to 1/2^(steps+1) of its width. */
const SHADOW_STEPS = 5;
/**
 * North and south faces show this share of their colour unlit, and get this much of the ambient light lit: a fake sun.
 * Lamp light is unshaded.
 */
export const SIDE_SHADE = 0.7;
/**
 * Walls and floor reflect only this many tiles from the eye, fading to nothing here: a streak along the wall the eye
 * is by stays near it, and a far wall that lies in line with the eye (close to its plane) barely flashes.
 */
export const REFLECTION_RANGE = 8;
/**
 * A wall reflects only while the eye is this close to it (tiles off its face), fading to nothing at this distance.
 * The floor is always half a tile off the eye.
 */
export const REFLECTION_NEAR = 4;
/**
 * Lamps a wall or floor sample can reflect: the LAMPS_PER_DIRECTION nearest in sight in each direction, east, west,
 * south and north (by the lamp's bearing), nearest first, −1 where there are fewer. By distance alone, a nearer lamp
 * behind the eye would push out the one ahead it's looking at; with one per direction, a corridor's nearer lamp
 * pushed out the one behind it in the row. Either way a reflection stopped dead at a line.
 */
const LAMPS_PER_DIRECTION = 2;
export const REFLECTION_LAMPS = 4 * LAMPS_PER_DIRECTION;
/** The lamp lists hold lamp indices as signed bytes (−1 for none), so a map can have this many lamps. */
const MAX_LAMPS = 127;
/**
 * A lamp's reflection fades over the whole path its light takes, lamp to surface to eye, to nothing at this many
 * tiles. Not its light's reach: a lamp shows mirrored in the floor however far its own light gets. Lamps are listed
 * within LAMP_SIGHT of a surface, and surfaces reflect within REFLECTION_RANGE of the eye, so in practice this only
 * dims, never cuts off.
 */
export const REFLECTION_PATH = 32;
/** Lamps are listed for reflection up to this far from a surface (tiles). */
const LAMP_SIGHT = 16;
/** A reflection sees a lamp's light this many times further than the lamp lights things: softly, never cut off. */
const REFLECTION_REACH = 1.5;
/** Lamp-sight cells per tile edge: past a lamp's light reach, a surface's sight of it is checked this coarsely. */
const SIGHT_SUB = 2;
/**
 * Which surfaces reflect the lamps (a console option): nothing, the walls, or the walls, floor and ceiling. 'only' is
 * the walls, floor and ceiling's reflections alone on black, with no baked light or avatar glow: a view of just them.
 */
export type ReflectionMode = 'none' | 'walls' | 'both' | 'only';
/** A full reflection adds this much of the lamp's colour (×255) on top of the lit texel. */
export const REFLECTION_STRENGTH = 0.385;
/** Heights a wall column's reflection is worked out at (0 to 1, evenly), blended between for each texel row. */
export const REFLECTION_SAMPLES = 17;

/** Bounce light: what the lit surfaces throw back, spread through the open floor, on top of the bare ambient. */
export interface Bounce {
  /** Each wall texture's average colour (index = tile id): the colour its lit faces throw back. */
  wallColours: readonly number[];
  /** How much of that light comes back as ambient, on top of the bare `ambient`. */
  strength: number;
}

/** Bounce light cells per tile edge: it's soft, so coarse is enough. */
const BOUNCE_SUB = 2;
/**
 * Blur rounds spreading bounce light through the open floor. Each round averages a cell with its four neighbours, so
 * light spreads about √(0.4 · rounds) cells: 4 cells, 2 tiles.
 */
const BOUNCE_ROUNDS = 40;

export interface Lighting {
  map: GameMap;
  lights: readonly Light[];
  /** The bare ambient, everywhere; bounce light (if baked) adds to it. */
  ambient: number;
  /** Bounce light per cell (BOUNCE_SUB per tile edge, row by row) × r, g, b, or null for flat ambient. */
  bounce: Float32Array | null;
  /** Per wall cell × face (0 W, 1 E, 2 N, 3 S): offset into `wall`, or −1 when the face touches no floor. */
  faceOffset: Int32Array;
  /**
   * Per face (faceOffset / (WALL_U · WALL_V)): its run, the unbroken line of faces on the same side it belongs to, as
   * start and end (tiles) along its axis: x for north and south faces, y for west and east ones.
   */
  faceRun: Int16Array;
  /** Packed multipliers, [face][u][v][relief level]: ambient + lamps × (1 + RELIEF_LEVELS[level]). */
  wall: Uint32Array;
  /**
   * Per face sample column ([face][u][k], so (faceOffset / WALL_V + u) · REFLECTION_LAMPS + k): the nearest lamps in
   * sight in each direction (see REFLECTION_LAMPS), or −1.
   */
  wallLamp: Int8Array;
  /** Per wallLamp slot: how much of its lamp the sample sees, 0..255 (a lamp part hidden by a wall's edge). */
  wallLampSeen: Uint8Array;
  /**
   * Per floor cell (like `floor`) × REFLECTION_LAMPS: the nearest lamps in sight in each direction, or −1. Lamps in
   * their light's reach use the floor light's own cells and sight lines, so a reflection's shadow edge is the floor's;
   * farther ones the coarse lamp sight (half-tile cells).
   */
  floorLamp: Int8Array;
  /** Per floorLamp slot: how much of its lamp the cell sees, 0..255. */
  floorLampSeen: Uint8Array;
  /** Final floor / ceiling colours, (map.width·FLOOR_SUB) × (map.height·FLOOR_SUB). */
  floor: Uint32Array;
  ceiling: Uint32Array;
  /** The floor and ceiling tables' size: cells across (a row's length) and rows. */
  stride: number;
  rows: number;
}

/** A surface's unit normal. */
export interface Normal {
  dx: number;
  dy: number;
  dz: number;
}

/** A wall face's outward normal, by face number (0 W, 1 E, 2 N, 3 S), as faceOffset numbers them. */
export const FACE_NORMALS: readonly Normal[] = [
  { dx: -1, dy: 0, dz: 0 },
  { dx: 1, dy: 0, dz: 0 },
  { dx: 0, dy: -1, dz: 0 },
  { dx: 0, dy: 1, dz: 0 },
];
/** The floor faces up. */
export const FLOOR_NORMAL: Normal = { dx: 0, dy: 0, dz: 1 };

/** How a surface reflects (see ReflectionMaterial); reflection() doesn't need its tint. */
type Gloss = Pick<ReflectionMaterial, 'shininess' | 'f0'>;

/** Where the eye stands, in tiles (a PlayerState will do). */
interface Eye {
  readonly x: number;
  readonly y: number;
}

function pack(r: number, g: number, b: number): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * ONE)));
  return (q(b) << 16) | (q(g) << 8) | q(r);
}

function tint(colour: number, r: number, g: number, b: number): number {
  const c = (v: number, k: number) => Math.min(255, Math.round(v * k));
  return rgb(c(colour & 0xff, r), c((colour >>> 8) & 0xff, g), c((colour >>> 16) & 0xff, b));
}

function falloff(dist: number, radius: number): number {
  const t = dist / radius;
  if (t >= 1) {
    return 0;
  }
  const k = 1 - t * t;
  return k * k;
}

/** The direction of a lamp lying (dx, dy) from a sample: 0 east, 1 west, 2 south, 3 north. */
function bearing(dx: number, dy: number): number {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0 ? 0 : 1;
  }
  return dy > 0 ? 2 : 3;
}

/** The cell at (x, y) in tiles on a grid of `sub` cells per tile edge, row by row, or −1 off the map. */
function gridCell(map: GameMap, sub: number, x: number, y: number): number {
  const across = map.width * sub;
  const cx = Math.floor(x * sub);
  const cy = Math.floor(y * sub);
  return cx < 0 || cy < 0 || cx >= across || cy >= map.height * sub ? -1 : cy * across + cx;
}

/** The ambient light, r, g, b into `out`, at (x, y): `ambient` plus any `bounce` light there. */
function ambientInto(
  map: GameMap,
  ambient: number,
  bounce: Float32Array | null,
  x: number,
  y: number,
  out: Float64Array
): void {
  out.fill(ambient);
  const at = bounce ? gridCell(map, BOUNCE_SUB, x, y) : -1;
  if (bounce && at >= 0) {
    for (let ch = 0; ch < 3; ch++) {
      out[ch] = ambient + (bounce[at * 3 + ch] as number);
    }
  }
}

/**
 * Bakes a map's lighting: its wall faces and their runs, then each wall sample and each floor and ceiling cell lit by
 * the lamps in sight (soft shadows) over the ambient, with `bounce` light on top if given, and the lamps each can
 * reflect. About 100 ms for LEVEL1. At most MAX_LAMPS lamps.
 */
export function bakeLighting(
  map: GameMap,
  lights: readonly Light[],
  ambient: number,
  floorColour: number,
  ceilingColour: number,
  bounce?: Bounce
): Lighting {
  if (lights.length > MAX_LAMPS) {
    throw new Error(`bakeLighting: ${lights.length} lamps, at most ${MAX_LAMPS} fit the lamp lists`);
  }
  const input: BakeInput = {
    map,
    lights,
    ambient,
    bounce: bounce ? bakeBounce(map, lights, floorColour, ceilingColour, bounce) : null,
    sight: bakeLampSight(map, lights),
  };
  const { faceOffset, faces } = indexFaces(map);
  const faceRun = faceRuns(map, faceOffset, faces);
  const { wall, wallLamp, wallLampSeen } = bakeWalls(input, faceOffset, faces);
  const { floor, ceiling, floorLamp, floorLampSeen, stride, rows } = bakeFloorAndCeiling(
    input,
    floorColour,
    ceilingColour
  );
  return {
    map,
    lights,
    ambient,
    bounce: input.bounce,
    faceOffset,
    faceRun,
    wall,
    wallLamp,
    wallLampSeen,
    floorLamp,
    floorLampSeen,
    floor,
    ceiling,
    stride,
    rows,
  };
}

/** The ambient light, r, g, b into `out`, at (x, y): the bare ambient plus any bounce light there. */
export function ambientAt(lm: Lighting, x: number, y: number, out: Float64Array): void {
  ambientInto(lm.map, lm.ambient, lm.bounce, x, y, out);
}

// Bake stages.

/** What every stage of a bake reads: the map, its lamps, the ambient and bounce light, and the coarse lamp sight. */
interface BakeInput {
  map: GameMap;
  lights: readonly Light[];
  ambient: number;
  bounce: Float32Array | null;
  /** bakeLampSight's table. */
  sight: Uint8Array;
}

/** Numbers every wall face with floor in front of it: faceOffset per wall cell × face (−1 for none), and the count. */
function indexFaces(map: GameMap): { faceOffset: Int32Array; faces: number } {
  const { width, height } = map;
  const faceOffset = new Int32Array(width * height * 4).fill(-1);
  let faces = 0;
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      if (tileAt(map, cx, cy) === 0) {
        continue;
      }
      for (const [f, n] of FACE_NORMALS.entries()) {
        if (tileAt(map, cx + n.dx, cy + n.dy) === 0) {
          faceOffset[(cy * width + cx) * 4 + f] = faces++ * WALL_U * WALL_V;
        }
      }
    }
  }
  return { faceOffset, faces };
}

/** Each face's run (see Lighting.faceRun): how far the unbroken line of faces on its side reaches either way. */
function faceRuns(map: GameMap, faceOffset: Int32Array, faces: number): Int16Array {
  const { width, height } = map;
  const faceRun = new Int16Array(faces * 2);
  const hasFace = (x: number, y: number, f: number) =>
    x >= 0 && y >= 0 && x < width && y < height && (faceOffset[(y * width + x) * 4 + f] as number) >= 0;
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      for (const [f, n] of FACE_NORMALS.entries()) {
        const base = faceOffset[(cy * width + cx) * 4 + f] as number;
        if (base < 0) {
          continue;
        }
        // North and south faces run along x, west and east ones along y.
        const alongX = n.dy !== 0;
        const sx = alongX ? 1 : 0;
        const sy = alongX ? 0 : 1;
        let back = 0;
        while (hasFace(cx - sx * (back + 1), cy - sy * (back + 1), f)) {
          back++;
        }
        let ahead = 0;
        while (hasFace(cx + sx * (ahead + 1), cy + sy * (ahead + 1), f)) {
          ahead++;
        }
        const at = alongX ? cx : cy;
        const face = base / (WALL_U * WALL_V);
        faceRun[face * 2] = at - back;
        faceRun[face * 2 + 1] = at + ahead + 1;
      }
    }
  }
  return faceRun;
}

/**
 * Each wall sample's light per relief level (ambient and bounce from the floor in front of it, plus the lamps in
 * sight), and the lamps each sample column can reflect.
 */
function bakeWalls(
  input: BakeInput,
  faceOffset: Int32Array,
  faces: number
): { wall: Uint32Array; wallLamp: Int8Array; wallLampSeen: Uint8Array } {
  const { map, lights } = input;
  const { width, height } = map;
  const levels = RELIEF_LEVELS.length;
  const wall = new Uint32Array(faces * WALL_U * WALL_V * levels);
  const wallLamp = new Int8Array(faces * WALL_U * REFLECTION_LAMPS).fill(-1);
  const wallLampSeen = new Uint8Array(wallLamp.length);
  const list = createLampList();
  const around = new Float64Array(3);
  // The lamps' light down the sample column, per WALL_V sample.
  const r = new Float64Array(WALL_V);
  const g = new Float64Array(WALL_V);
  const b = new Float64Array(WALL_V);
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      for (const [f, n] of FACE_NORMALS.entries()) {
        const base = faceOffset[(cy * width + cx) * 4 + f] as number;
        if (base < 0) {
          continue;
        }
        const shade = n.dy !== 0 ? SIDE_SHADE : 1;
        for (let u = 0; u < WALL_U; u++) {
          const along = (u + 0.5) / WALL_U;
          const px = n.dx === 0 ? cx + along : n.dx < 0 ? cx : cx + 1;
          const py = n.dy === 0 ? cy + along : n.dy < 0 ? cy : cy + 1;
          // The ambient of the floor just in front of this sample.
          ambientInto(map, input.ambient, input.bounce, px + n.dx * 0.25, py + n.dy * 0.25, around);
          const ar = (around[0] as number) * shade;
          const ag = (around[1] as number) * shade;
          const ab = (around[2] as number) * shade;
          r.fill(0);
          g.fill(0);
          b.fill(0);
          clearLampList(list);
          for (let i = 0; i < lights.length; i++) {
            const l = lights.at(i);
            if (!l) {
              continue;
            }
            const dx = l.x - px;
            const dy = l.y - py;
            const facing = dx * n.dx + dy * n.dy;
            const flat = Math.hypot(dx, dy);
            if (facing <= 0 || flat >= LAMP_SIGHT) {
              continue;
            }
            // Exact sight lines, past its light's reach too: a far lamp seen through a doorway is shaded softly by the
            // door's edge, over tiles, and a coarse yes or no would end its reflection at a hard line.
            const lit = flat < l.radius;
            const seen = seenShare(map, px + n.dx * 1e-3, py + n.dy * 1e-3, l);
            if (seen === 0) {
              continue;
            }
            offerLamp(list, i, dx, dy, flat, seen);
            if (!lit) {
              continue;
            }
            for (let v = 0; v < WALL_V; v++) {
              const dz = l.z - (1 - (v + 0.5) / WALL_V);
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
              const k = falloff(dist, l.radius) * (facing / dist) * seen;
              r[v] = (r[v] as number) + l.r * k;
              g[v] = (g[v] as number) + l.g * k;
              b[v] = (b[v] as number) + l.b * k;
            }
          }
          wallLamp.set(list.lamps, (base / WALL_V + u) * REFLECTION_LAMPS);
          wallLampSeen.set(list.seen, (base / WALL_V + u) * REFLECTION_LAMPS);
          for (let v = 0; v < WALL_V; v++) {
            const rv = r[v] as number;
            const gv = g[v] as number;
            const bv = b[v] as number;
            for (let k = 0; k < levels; k++) {
              const lift = 1 + (RELIEF_LEVELS.at(k) ?? 0);
              wall[(base + u * WALL_V + v) * levels + k] = pack(ar + rv * lift, ag + gv * lift, ab + bv * lift);
            }
          }
        }
      }
    }
  }
  return { wall, wallLamp, wallLampSeen };
}

/** Each floor and ceiling cell's colour, lit like the walls, and the lamps each floor cell can reflect. */
function bakeFloorAndCeiling(
  input: BakeInput,
  floorColour: number,
  ceilingColour: number
): {
  floor: Uint32Array;
  ceiling: Uint32Array;
  floorLamp: Int8Array;
  floorLampSeen: Uint8Array;
  stride: number;
  rows: number;
} {
  const { map, lights, ambient } = input;
  const stride = map.width * FLOOR_SUB;
  const rows = map.height * FLOOR_SUB;
  const floor = new Uint32Array(stride * rows).fill(tint(floorColour, ambient, ambient, ambient));
  const ceiling = new Uint32Array(stride * rows).fill(tint(ceilingColour, ambient, ambient, ambient));
  const floorLamp = new Int8Array(stride * rows * REFLECTION_LAMPS).fill(-1);
  const floorLampSeen = new Uint8Array(floorLamp.length);
  const list = createLampList();
  const around = new Float64Array(3);
  for (let sy = 0; sy < rows; sy++) {
    for (let sx = 0; sx < stride; sx++) {
      const px = (sx + 0.5) / FLOOR_SUB;
      const py = (sy + 0.5) / FLOOR_SUB;
      if (tileAt(map, Math.floor(px), Math.floor(py)) !== 0) {
        continue;
      }
      ambientInto(map, ambient, input.bounce, px, py, around);
      let fr = around[0] as number;
      let fg = around[1] as number;
      let fb = around[2] as number;
      let cr = fr;
      let cg = fg;
      let cb = fb;
      let fixture = false;
      clearLampList(list);
      for (let i = 0; i < lights.length; i++) {
        const l = lights.at(i);
        if (!l) {
          continue;
        }
        const dx = l.x - px;
        const dy = l.y - py;
        const flat = Math.hypot(dx, dy);
        if (flat >= LAMP_SIGHT) {
          continue;
        }
        const lit = flat < l.radius;
        const seen = lit ? seenShare(map, px, py, l) : seesCoarsely(input, px, py, i) ? 1 : 0;
        if (seen === 0) {
          continue;
        }
        offerLamp(list, i, dx, dy, flat, seen);
        if (!lit) {
          continue;
        }
        if (flat < FIXTURE_RADIUS) {
          fixture = true;
        }
        const df = Math.sqrt(flat * flat + l.z * l.z);
        const kf = falloff(df, l.radius) * (l.z / df) * seen;
        fr += l.r * kf;
        fg += l.g * kf;
        fb += l.b * kf;
        const up = 1 - l.z;
        const dc = Math.sqrt(flat * flat + up * up);
        // The ceiling sees the lamp almost edge-on; lift it a little so the pool still reads.
        const kc = falloff(dc, l.radius) * Math.max(0.35, up / dc) * seen;
        cr += l.r * kc;
        cg += l.g * kc;
        cb += l.b * kc;
      }
      floorLamp.set(list.lamps, (sy * stride + sx) * REFLECTION_LAMPS);
      floorLampSeen.set(list.seen, (sy * stride + sx) * REFLECTION_LAMPS);
      floor[sy * stride + sx] = tint(floorColour, fr, fg, fb);
      ceiling[sy * stride + sx] = fixture ? FIXTURE : tint(ceilingColour, cr, cg, cb);
    }
  }
  return { floor, ceiling, floorLamp, floorLampSeen, stride, rows };
}

/**
 * A sample's lamps being listed for reflection: per direction (`bearing`), the LAMPS_PER_DIRECTION nearest in sight
 * so far, nearest first, with their distances and how much of each the sample sees (0..255).
 */
interface LampList {
  lamps: Int8Array;
  dist: Float64Array;
  seen: Uint8Array;
}

function createLampList(): LampList {
  return {
    lamps: new Int8Array(REFLECTION_LAMPS),
    dist: new Float64Array(REFLECTION_LAMPS),
    seen: new Uint8Array(REFLECTION_LAMPS),
  };
}

function clearLampList(list: LampList): void {
  list.lamps.fill(-1);
  list.dist.fill(Number.POSITIVE_INFINITY);
  list.seen.fill(0);
}

/** Lists lamp i, lying (dx, dy) and `dist` tiles away, `seen` 0..1 of it, if it's among its direction's nearest. */
function offerLamp(list: LampList, i: number, dx: number, dy: number, dist: number, seen: number): void {
  const { lamps, dist: dists, seen: seens } = list;
  const first = bearing(dx, dy) * LAMPS_PER_DIRECTION;
  // Insert in distance order, dropping the farthest of the direction's slots.
  for (let k = first; k < first + LAMPS_PER_DIRECTION; k++) {
    if (dist < (dists[k] as number)) {
      for (let m = first + LAMPS_PER_DIRECTION - 1; m > k; m--) {
        dists[m] = dists[m - 1] as number;
        lamps[m] = lamps[m - 1] as number;
        seens[m] = seens[m - 1] as number;
      }
      dists[k] = dist;
      lamps[k] = i;
      seens[k] = Math.round(seen * 255);
      return;
    }
  }
}

/**
 * How much of lamp `l` the point (x, y) sees, 0..1. Seen from above in 2D the lamp's disc is a line across the sight
 * line to it, LAMP_RADIUS either side: when sight lines to its two ends disagree, a wall's edge cuts it, found by
 * halving, and the share is the disc's area on the seen side of the cut.
 */
function seenShare(map: GameMap, x: number, y: number, l: Light): number {
  const dx = l.x - x;
  const dy = l.y - y;
  const len = Math.hypot(dx, dy) || 1;
  const ox = (-dy / len) * LAMP_RADIUS;
  const oy = (dx / len) * LAMP_RADIUS;
  const sees = (t: number) => hasLineOfSight(map, x, y, l.x + ox * t, l.y + oy * t);
  const left = sees(-1);
  if (left === sees(1)) {
    return left ? 1 : 0;
  }
  let lo = -1;
  let hi = 1;
  for (let i = 0; i < SHADOW_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (sees(mid) === left) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // The unit disc's area past t, as a share of the whole.
  const t = (lo + hi) / 2;
  const past = (Math.acos(t) - t * Math.sqrt(1 - t * t)) / Math.PI;
  return left ? 1 - past : past;
}

/** Whether the floor at (x, y) can see lamp i, by the coarse lamp-sight cells (bakeLampSight). */
function seesCoarsely(input: BakeInput, x: number, y: number, i: number): boolean {
  const at = gridCell(input.map, SIGHT_SUB, x, y);
  return at >= 0 && input.sight[at * input.lights.length + i] === 1;
}

/**
 * Per lamp-sight cell × lamp: 1 if the open floor at the cell's centre can see the lamp, within LAMP_SIGHT. It lets
 * the walls and floor list lamps past their light's reach for reflection without a sight line per fine sample.
 */
function bakeLampSight(map: GameMap, lights: readonly Light[]): Uint8Array {
  const across = map.width * SIGHT_SUB;
  const down = map.height * SIGHT_SUB;
  const sight = new Uint8Array(across * down * lights.length);
  for (let cy = 0; cy < down; cy++) {
    for (let cx = 0; cx < across; cx++) {
      const px = (cx + 0.5) / SIGHT_SUB;
      const py = (cy + 0.5) / SIGHT_SUB;
      if (tileAt(map, Math.floor(px), Math.floor(py)) !== 0) {
        continue;
      }
      lights.forEach((l, i) => {
        if (Math.hypot(l.x - px, l.y - py) < LAMP_SIGHT && hasLineOfSight(map, px, py, l.x, l.y)) {
          sight[(cy * across + cx) * lights.length + i] = 1;
        }
      });
    }
  }
  return sight;
}

/**
 * Bounce light per cell: first what each open cell's surfaces throw back, the lamps' direct light on its floor,
 * ceiling and bordering wall faces times each one's colour, averaged; then spread through the open floor by
 * BOUNCE_ROUNDS rounds of blur, never through walls. One soft bounce, baked once.
 */
function bakeBounce(
  map: GameMap,
  lights: readonly Light[],
  floorColour: number,
  ceilingColour: number,
  bounce: Bounce
): Float32Array {
  const across = map.width * BOUNCE_SUB;
  const down = map.height * BOUNCE_SUB;
  const cells = across * down;
  const open = (cx: number, cy: number) =>
    cx >= 0 &&
    cy >= 0 &&
    cx < across &&
    cy < down &&
    tileAt(map, Math.floor(cx / BOUNCE_SUB), Math.floor(cy / BOUNCE_SUB)) === 0;
  const albedo = (colour: number, ch: number) => ((colour >>> (ch * 8)) & 0xff) / 255;
  let light = new Float32Array(cells * 3);
  const direct = new Float64Array(3);
  for (let cy = 0; cy < down; cy++) {
    for (let cx = 0; cx < across; cx++) {
      if (!open(cx, cy)) {
        continue;
      }
      const px = (cx + 0.5) / BOUNCE_SUB;
      const py = (cy + 0.5) / BOUNCE_SUB;
      const sum = [0, 0, 0];
      let surfaces = 0;
      // The floor and the ceiling.
      for (const [z, colour] of [
        [0, floorColour],
        [1, ceilingColour],
      ] as const) {
        lampsOn(map, lights, px, py, z, 0, 0, direct);
        for (let ch = 0; ch < 3; ch++) {
          sum[ch] = (sum[ch] as number) + (direct[ch] as number) * albedo(colour, ch);
        }
        surfaces++;
      }
      // Any wall faces bordering the cell, lit at mid height, facing back into it.
      for (const n of FACE_NORMALS) {
        if (open(cx + n.dx, cy + n.dy)) {
          continue;
        }
        const tile = tileAt(map, Math.floor((cx + n.dx) / BOUNCE_SUB), Math.floor((cy + n.dy) / BOUNCE_SUB));
        const colour = bounce.wallColours[tile] ?? 0;
        const fx = px + (n.dx * 0.5) / BOUNCE_SUB;
        const fy = py + (n.dy * 0.5) / BOUNCE_SUB;
        lampsOn(map, lights, fx, fy, 0.5, -n.dx, -n.dy, direct);
        for (let ch = 0; ch < 3; ch++) {
          sum[ch] = (sum[ch] as number) + (direct[ch] as number) * albedo(colour, ch);
        }
        surfaces++;
      }
      for (let ch = 0; ch < 3; ch++) {
        light[(cy * across + cx) * 3 + ch] = ((sum[ch] as number) / surfaces) * bounce.strength;
      }
    }
  }
  // Spread: each round, an open cell takes the average of itself and its open neighbours.
  let next = new Float32Array(cells * 3);
  for (let round = 0; round < BOUNCE_ROUNDS; round++) {
    for (let cy = 0; cy < down; cy++) {
      for (let cx = 0; cx < across; cx++) {
        if (!open(cx, cy)) {
          continue;
        }
        const at = (cy * across + cx) * 3;
        let n = 1;
        let r = light[at] as number;
        let g = light[at + 1] as number;
        let b = light[at + 2] as number;
        for (const d of FACE_NORMALS) {
          if (open(cx + d.dx, cy + d.dy)) {
            const there = ((cy + d.dy) * across + cx + d.dx) * 3;
            r += light[there] as number;
            g += light[there + 1] as number;
            b += light[there + 2] as number;
            n++;
          }
        }
        next[at] = r / n;
        next[at + 1] = g / n;
        next[at + 2] = b / n;
      }
    }
    [light, next] = [next, light];
  }
  return light;
}

/**
 * The lamps' direct light, r, g, b into `out`, on a surface at (x, y, z): the floor (z 0) and ceiling (z 1) face up
 * and down; a wall point facing (nx, ny) is lit by what's in front of it. Only lamps in reach and in sight count.
 * Hard shadows, and no lift for the ceiling (unlike its baked colour): bounce light is soft enough not to show it.
 */
function lampsOn(
  map: GameMap,
  lights: readonly Light[],
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  out: Float64Array
): void {
  out.fill(0);
  for (const l of lights) {
    const dx = l.x - x;
    const dy = l.y - y;
    const dz = l.z - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const facing = nx === 0 && ny === 0 ? Math.abs(dz) / dist : (dx * nx + dy * ny) / dist;
    const k = facing > 0 ? falloff(dist, l.radius) * facing : 0;
    if (k === 0 || !hasLineOfSight(map, x + nx * 1e-3, y + ny * 1e-3, l.x, l.y)) {
      continue;
    }
    out[0] = (out[0] as number) + l.r * k;
    out[1] = (out[1] as number) + l.g * k;
    out[2] = (out[2] as number) + l.b * k;
  }
}

// Reflections, per frame.

/**
 * How brightly lamp `l` reflects at (px, py, pz) on a surface facing `n` (a wall, or the floor facing up), seen from
 * the eye, 0..1 before the lamp's colour; the lamp is taken at height `lampZ`, `l.z` but for the ceiling's mirrored
 * lamps.
 *
 * One model for every angle: Blinn-Phong, (n·h)^shininess with h halfway between the lamp and the eye, times a boost
 * at shallow angles, f0 + (1 − f0)·(1 − (v·h)²), times how brightly the lamp lights the surface,
 * 1 / (1 + (d / (REFLECTION_REACH × its reach))²), times a fade over the whole path, lamp to surface to eye, to nothing
 * at REFLECTION_PATH. The lamp term is gentle, never cut off at the light's reach, so a far lamp seen through a
 * doorway still leaves a streak, and a streak still grows towards its lamp.
 *
 * Face-on it's a soft spot where the wall mirrors the lamp, worth f0 of itself; looking along the wall the same
 * reflection stretches into a streak towards the lamp, near full strength. Glossy surfaces (high shininess) give a
 * small spot and a narrow streak, rough ones a faint wide spot and a long streak. Schlick's (1 − v·h)⁵ boost only
 * rises past 80°, and a corridor's reflections sit at 60–70°.
 *
 * Shadows are the caller's (wallLampSeen, floorLampSeen). `shininess` is a power of two (it's raised by squaring).
 * It takes three square roots, so callers sample it sparsely: a wall column at REFLECTION_SAMPLES heights, the floor
 * every few pixels.
 *
 * Up to ~90k calls a frame: it must stay small enough for V8 to inline (460 bytes of bytecode by default), or every
 * call boxes its doubles (−0.16 ms a frame in bench:walls). Hence the helpers, and no default `lampZ`.
 */
export function reflection(
  l: Light,
  gloss: Gloss,
  n: Normal,
  px: number,
  py: number,
  pz: number,
  eye: Eye,
  lampZ: number
): number {
  const lx = l.x - px;
  const ly = l.y - py;
  const lz = lampZ - pz;
  if (lx * n.dx + ly * n.dy + lz * n.dz <= 0) {
    return 0;
  }
  const l2 = lx * lx + ly * ly + lz * lz;
  const vx = eye.x - px;
  const vy = eye.y - py;
  const vz = EYE_HEIGHT - pz;
  const lampLen = Math.sqrt(l2);
  const eyeLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const fade = pathFade(lampLen + eyeLen);
  if (fade === 0) {
    return 0;
  }
  // Halfway between the directions to the lamp and to the eye.
  const hx = lx / lampLen + vx / eyeLen;
  const hy = ly / lampLen + vy / eyeLen;
  const hz = lz / lampLen + vz / eyeLen;
  const halfLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const nh = (hx * n.dx + hy * n.dy + hz * n.dz) / halfLen;
  if (nh <= 0) {
    return 0;
  }
  const vh = (vx * hx + vy * hy + vz * hz) / (eyeLen * halfLen);
  return specular(nh, vh, gloss) * lampLit(l, l2) * fade * fade;
}

/** The fade over a reflection's path, lamp to surface to eye, `length` tiles long: 1 − (length / REFLECTION_PATH)², 0
 * from REFLECTION_PATH on. */
function pathFade(length: number): number {
  const path = length / REFLECTION_PATH;
  return path >= 1 ? 0 : 1 - path * path;
}

/** Blinn-Phong's lobe, (n·h)^shininess, times the shallow-angle boost (see reflection()). */
function specular(nh: number, vh: number, gloss: Gloss): number {
  let lobe = nh;
  for (let m = 1; m < gloss.shininess; m *= 2) {
    lobe *= lobe;
  }
  return lobe * (gloss.f0 + (1 - gloss.f0) * (1 - vh * vh));
}

/** How brightly lamp `l` lights a surface `l2` (tiles²) from it, as its reflection sees it: never cut off. */
function lampLit(l: Light, l2: number): number {
  const reach = l.radius * REFLECTION_REACH;
  return 1 / (1 + l2 / (reach * reach));
}

/**
 * How far the eye is from the wall itself, not its endless plane: from the run of faces (`faceRun`) that the face at
 * `base` (its faceOffset) belongs to, facing `n`, with (px, py) a point on it. Alongside the run it's how far the eye
 * stands off it; past its end, the distance to that end. So a far wall face lying in line with the eye counts as far.
 */
export function distanceToWall(lm: Lighting, base: number, n: Normal, px: number, py: number, eye: Eye): number {
  const face = base / (WALL_U * WALL_V);
  const start = lm.faceRun[face * 2] as number;
  const end = lm.faceRun[face * 2 + 1] as number;
  const off = (eye.x - px) * n.dx + (eye.y - py) * n.dy;
  // West and east faces run along y, north and south ones along x.
  const along = n.dx !== 0 ? eye.y : eye.x;
  const gap = along < start ? start - along : along > end ? along - end : 0;
  // Not Math.hypot: V8 doesn't inline it, and every call boxes its result.
  return Math.sqrt(off * off + gap * gap);
}

/**
 * The height on a wall's column at (px, py) where the wall bounces the ray from the eye at (ex, ey) to lamp `l`: where
 * the ray climbs from the eye's height to the lamp's over its two legs, eye to wall and wall to lamp, seen from above.
 * A lamp's reflection on that column peaks about there.
 */
export function bounceHeight(l: Light, px: number, py: number, ex: number, ey: number): number {
  // Not Math.hypot, as in distanceToWall: per column, per lamp.
  const eyeLeg = Math.sqrt((px - ex) * (px - ex) + (py - ey) * (py - ey));
  const lampLeg = Math.sqrt((l.x - px) * (l.x - px) + (l.y - py) * (l.y - py));
  return (EYE_HEIGHT * lampLeg + l.z * eyeLeg) / (eyeLeg + lampLeg);
}

// Moving objects, per frame.

/** A voxel face's direction in model space (+x front, +y the model's right, +z up), as voxels.ts orders them. */
export const DIR_TOP = 0;
export const DIR_FRONT = 1;
export const DIR_BACK = 2;
export const DIR_RIGHT = 3;
export const DIR_LEFT = 4;

/**
 * Light from the lamps (ambient not included) reaching a moving object at (x, y, z) turned to `angle`, per face
 * direction: `out` gets r, g, b for each DIR_* in turn. Only lamps in reach and in sight count, so a few per call.
 */
export function directLight(lm: Lighting, x: number, y: number, z: number, angle: number, out: Float64Array): void {
  out.fill(0);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (const l of lm.lights) {
    const dx = l.x - x;
    const dy = l.y - y;
    const dz = l.z - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const k = falloff(dist, l.radius);
    if (k === 0 || !hasLineOfSight(lm.map, x, y, l.x, l.y)) {
      continue;
    }
    // The lamp's direction in model space: rotate the horizontal part by −angle.
    const fx = (dx * ca + dy * sa) / dist;
    const fy = (-dx * sa + dy * ca) / dist;
    addLight(out, DIR_TOP, l, k * Math.max(0, dz / dist));
    addLight(out, DIR_FRONT, l, k * Math.max(0, fx));
    addLight(out, DIR_BACK, l, k * Math.max(0, -fx));
    addLight(out, DIR_RIGHT, l, k * Math.max(0, fy));
    addLight(out, DIR_LEFT, l, k * Math.max(0, -fy));
  }
}

function addLight(out: Float64Array, dir: number, l: Light, k: number): void {
  out[dir * 3] = (out[dir * 3] as number) + l.r * k;
  out[dir * 3 + 1] = (out[dir * 3 + 1] as number) + l.g * k;
  out[dir * 3 + 2] = (out[dir * 3 + 2] as number) + l.b * k;
}

// Placing lamps.

/** A corridor lamp's colour × intensity: warm white, a little overbright at the lamp. */
export const LAMP = { r: 1.25, g: 1.05, b: 0.75 };
/** Corridor lamps hang this high (0..1, the ceiling is 1). */
const LAMP_HEIGHT = 0.85;

/**
 * Lamps along every corridor (a floor run at most 3 tiles across and at least 4 long), on its centre line, at
 * least `spacing` tiles apart.
 */
export function corridorLights(map: GameMap, spacing = 5, radius = 4.5): Light[] {
  const { width, height } = map;
  const floor = (x: number, y: number) => tileAt(map, x, y) === 0;
  const lights: Light[] = [];
  const far = (x: number, y: number) => lights.every((l) => Math.hypot(l.x - x, l.y - y) >= spacing);
  const run = (x: number, y: number, dx: number, dy: number) => {
    let a = 0;
    while (floor(x - dx * (a + 1), y - dy * (a + 1))) {
      a++;
    }
    let b = 0;
    while (floor(x + dx * (b + 1), y + dy * (b + 1))) {
      b++;
    }
    return { a, b, len: a + b + 1 };
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!floor(x, y)) {
        continue;
      }
      const h = run(x, y, 1, 0);
      const v = run(x, y, 0, 1);
      let lx: number;
      let ly: number;
      if (h.len <= 3 && v.len >= 4) {
        lx = x - h.a + h.len / 2;
        ly = y + 0.5;
      } else if (v.len <= 3 && h.len >= 4) {
        lx = x + 0.5;
        ly = y - v.a + v.len / 2;
      } else {
        continue;
      }
      if (far(lx, ly)) {
        lights.push({ x: lx, y: ly, z: LAMP_HEIGHT, radius, ...LAMP });
      }
    }
  }
  return lights;
}
