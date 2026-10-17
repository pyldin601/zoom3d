// The bake: every light sample in the room, listed once, goes through one pass after another into the lightmaps
// (spec docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §3.2). The lamps never move, so it runs once,
// a slice per frame; `bakeLighting` yields the fraction done after each slice.

import {
  FLOOR_CELLS,
  planeCellOffset,
  type TracedLightmaps,
  WALL_COLUMNS,
  WALL_HEIGHTS,
  wallSampleHeight,
  wallSampleOffset,
} from './lightmaps';
import { clearBetween } from './ray';
import { FACE_NORMAL_X, FACE_NORMAL_Y, isWall, LAMP_RADIUS, NO_FACE, type TracedWorld } from './world';

/** A lamp's light fades to nothing at this distance along the floor (tiles). */
const LAMP_REACH = 8;
/** Strips across a lamp that is partly hidden, a shadow ray each. */
const STRIPS = 8;
/**
 * How far across the lamp (share of its radius) the two edge rays aim. Short of the rim, at about where the outermost
 * strips aim (0.875), so edges that agree mean the strips would too.
 */
const EDGE_RAY_SHARE = 0.9;
/** Closer than this to straight below a lamp (tiles), there is no direction across it to aim along. */
const BELOW_LAMP = 1e-6;
/** A wall sample sits this far in front of its face (tiles), so its shadow rays start in open space. */
const WALL_STANDOFF = 1e-3;
/** Samples between yields: about 0.1 ms on LEVEL1, so the frame loop can stop close to its time budget. */
const SAMPLES_PER_SLICE = 512;

/** A point on a surface (tiles; z 0 floor .. 1 ceiling) and the unit normal it faces along. */
export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

function createSurfacePoint(): SurfacePoint {
  return { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
}

const SURFACE_FLOOR = 0;
const SURFACE_CEILING = 1;
const SURFACE_WALL = 2;

/** Every light sample, struct of arrays: its place and facing, which map it lights and where in that map. */
interface LightSamples {
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  nx: Int8Array;
  ny: Int8Array;
  nz: Int8Array;
  /** SURFACE_*: which of the floor, ceiling and wall maps the sample is in. */
  surface: Uint8Array;
  /** Where in that map the sample's rgb starts. */
  offset: Int32Array;
}

/** Fills `maps` a slice at a time; each yield is the fraction done, 0..1, and the last is exactly 1. */
type BakePass = (world: TracedWorld, maps: TracedLightmaps, samples: LightSamples) => Generator<number, void, void>;

/** In order; each reports its own 0..1 and is given an equal share of the whole. */
const BAKE_PASSES: readonly BakePass[] = [bakeDirectLight];

/** The disc as one sample sees it from the side: its centre and the 2D direction across it. */
interface LampDisc {
  x: number;
  y: number;
  acrossX: number;
  acrossY: number;
}

const sampleScratch = createSurfacePoint();
const lightScratch = new Float32Array(3);
const discScratch: LampDisc = { x: 0, y: 0, acrossX: 0, acrossY: 0 };

/** Strips across the lamp at these offsets from its centre (tiles), a chord's length (normalised) of it each. */
const STRIP_OFFSETS = Float64Array.from({ length: STRIPS }, (_, strip) => stripPosition(strip) * LAMP_RADIUS);
const STRIP_WEIGHTS = (() => {
  const chords = Float64Array.from({ length: STRIPS }, (_, strip) => Math.sqrt(1 - stripPosition(strip) ** 2));
  const total = chords.reduce((sum, chord) => sum + chord, 0);
  return chords.map((chord) => chord / total);
})();

/** Strip `strip`'s middle across the lamp, from -1 to 1. */
function stripPosition(strip: number): number {
  return ((strip + 0.5) / STRIPS) * 2 - 1;
}

/**
 * The lamps' light at a surface point, into `out` as linear rgb: radiance × r² × cos(surface) × cos(lamp) / d²,
 * faded to nothing by LAMP_REACH, times the share of the disc the point sees. A ceiling point gets none: the disc
 * faces down. Allocation-free, and everything it calls reads typed arrays by index: LEVEL1's direct bake took 39 ms
 * that way and 325 ms with `.at()`.
 */
export function lampLight(world: TracedWorld, at: SurfacePoint, out: Float32Array): void {
  let irradiance = 0;
  for (let lamp = 0; lamp < world.lampX.length; lamp++) {
    irradiance += irradianceFromLamp(world, at, lamp);
  }
  for (let channel = 0; channel < 3; channel++) {
    out[channel] = irradiance * (world.lampRgb[channel] ?? 0);
  }
}

/** Fills `maps` with the room's light from the lamps, then each later pass on top, yielding the fraction done. */
export function* bakeLighting(world: TracedWorld, maps: TracedLightmaps): Generator<number, void, void> {
  const samples = listLightSamples(world);
  for (const [index, pass] of BAKE_PASSES.entries()) {
    for (const passDone of pass(world, maps, samples)) {
      yield (index + passDone) / BAKE_PASSES.length;
    }
  }
}

function* bakeDirectLight(
  world: TracedWorld,
  maps: TracedLightmaps,
  samples: LightSamples
): Generator<number, void, void> {
  for (let sample = 0; sample < samples.count; sample++) {
    loadSample(samples, sample, sampleScratch);
    lampLight(world, sampleScratch, lightScratch);
    lightmapOf(maps, samples.surface[sample] ?? SURFACE_FLOOR).set(lightScratch, samples.offset[sample] ?? 0);
    const done = sample + 1;
    if (done % SAMPLES_PER_SLICE === 0 || done === samples.count) {
      yield done / samples.count;
    }
  }
}

function lightmapOf(maps: TracedLightmaps, surface: number): Float32Array {
  switch (surface) {
    case SURFACE_CEILING:
      return maps.ceiling;
    case SURFACE_WALL:
      return maps.wall;
    default:
      return maps.floor;
  }
}

function loadSample(samples: LightSamples, sample: number, into: SurfacePoint): void {
  into.x = samples.x[sample] ?? 0;
  into.y = samples.y[sample] ?? 0;
  into.z = samples.z[sample] ?? 0;
  into.nx = samples.nx[sample] ?? 0;
  into.ny = samples.ny[sample] ?? 0;
  into.nz = samples.nz[sample] ?? 0;
}

/** One lamp's irradiance at the point before the lamp's colour; 0 out of its reach or when it faces away. */
function irradianceFromLamp(world: TracedWorld, at: SurfacePoint, lamp: number): number {
  const toLampX = (world.lampX[lamp] ?? 0) - at.x;
  const toLampY = (world.lampY[lamp] ?? 0) - at.y;
  const toLampZ = 1 - at.z;
  const flat = Math.sqrt(toLampX * toLampX + toLampY * toLampY);
  if (flat >= LAMP_REACH || toLampZ <= 0) {
    return 0;
  }
  const distanceSquared = flat * flat + toLampZ * toLampZ;
  const distance = Math.sqrt(distanceSquared);
  const cosSurface = (at.nx * toLampX + at.ny * toLampY + at.nz * toLampZ) / distance;
  if (cosSurface <= 0) {
    return 0;
  }
  const cosLamp = toLampZ / distance;
  const reachShare = (flat / LAMP_REACH) ** 2;
  const fade = (1 - reachShare * reachShare) ** 2;
  const unshadowed = (cosSurface * cosLamp * LAMP_RADIUS * LAMP_RADIUS * fade) / distanceSquared;
  return unshadowed * seenShare(world, at, lamp);
}

/** The share of the lamp's disc the point sees: shadow rays to its centre and edges, strips across it if they differ. */
function seenShare(world: TracedWorld, at: SurfacePoint, lamp: number): number {
  const disc = aimAcrossLamp(world, at, lamp, discScratch);
  if (disc === null) {
    return 1;
  }
  const edge = EDGE_RAY_SHARE * LAMP_RADIUS;
  const centre = clearToDisc(world, at, disc, 0);
  const left = clearToDisc(world, at, disc, -edge);
  const right = clearToDisc(world, at, disc, edge);
  if (centre && left && right) {
    return 1;
  }
  if (!centre && !left && !right) {
    return 0;
  }
  return seenByStrips(world, at, disc);
}

/** The lamp as the point sees it, or null from straight below, where nothing can stand between. */
function aimAcrossLamp(world: TracedWorld, at: SurfacePoint, lamp: number, into: LampDisc): LampDisc | null {
  into.x = world.lampX[lamp] ?? 0;
  into.y = world.lampY[lamp] ?? 0;
  const toLampX = into.x - at.x;
  const toLampY = into.y - at.y;
  const flat = Math.sqrt(toLampX * toLampX + toLampY * toLampY);
  if (flat < BELOW_LAMP) {
    return null;
  }
  into.acrossX = -toLampY / flat;
  into.acrossY = toLampX / flat;
  return into;
}

function seenByStrips(world: TracedWorld, at: SurfacePoint, disc: LampDisc): number {
  let seen = 0;
  for (let strip = 0; strip < STRIPS; strip++) {
    if (clearToDisc(world, at, disc, STRIP_OFFSETS[strip] ?? 0)) {
      seen += STRIP_WEIGHTS[strip] ?? 0;
    }
  }
  return seen;
}

/** Whether nothing stands between the point and the spot `across` tiles from the disc's centre. */
function clearToDisc(world: TracedWorld, at: SurfacePoint, disc: LampDisc, across: number): boolean {
  return clearBetween(world, at.x, at.y, disc.x + disc.acrossX * across, disc.y + disc.acrossY * across);
}

/** Floor and ceiling cells of every open tile, then the samples of every wall face that has floor in front. */
function listLightSamples(world: TracedWorld): LightSamples {
  const samples = allocateSamples(sampleCount(world));
  const at = createSurfacePoint();
  for (let tileY = 0; tileY < world.height; tileY++) {
    for (let tileX = 0; tileX < world.width; tileX++) {
      if (isWall(world, tileX, tileY)) {
        addWallSamples(samples, at, world, tileX, tileY);
      } else {
        addPlaneSamples(samples, at, world, tileX, tileY);
      }
    }
  }
  return samples;
}

function sampleCount(world: TracedWorld): number {
  const openTiles = world.map.tiles.reduce((open, tile) => open + (tile === 0 ? 1 : 0), 0);
  const planeSamples = openTiles * FLOOR_CELLS * FLOOR_CELLS * 2;
  return planeSamples + world.faceCount * WALL_HEIGHTS * WALL_COLUMNS;
}

function allocateSamples(capacity: number): LightSamples {
  return {
    count: 0,
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    z: new Float64Array(capacity),
    nx: new Int8Array(capacity),
    ny: new Int8Array(capacity),
    nz: new Int8Array(capacity),
    surface: new Uint8Array(capacity),
    offset: new Int32Array(capacity),
  };
}

function addSample(samples: LightSamples, at: SurfacePoint, surface: number, offset: number): void {
  const sample = samples.count++;
  samples.x[sample] = at.x;
  samples.y[sample] = at.y;
  samples.z[sample] = at.z;
  samples.nx[sample] = at.nx;
  samples.ny[sample] = at.ny;
  samples.nz[sample] = at.nz;
  samples.surface[sample] = surface;
  samples.offset[sample] = offset;
}

function addPlaneSamples(
  samples: LightSamples,
  at: SurfacePoint,
  world: TracedWorld,
  tileX: number,
  tileY: number
): void {
  for (let row = 0; row < FLOOR_CELLS; row++) {
    for (let column = 0; column < FLOOR_CELLS; column++) {
      const cellX = tileX * FLOOR_CELLS + column;
      const cellY = tileY * FLOOR_CELLS + row;
      const offset = planeCellOffset(world, cellX, cellY);
      at.x = tileX + (column + 0.5) / FLOOR_CELLS;
      at.y = tileY + (row + 0.5) / FLOOR_CELLS;
      at.z = 0;
      at.nx = 0;
      at.ny = 0;
      at.nz = 1;
      addSample(samples, at, SURFACE_FLOOR, offset);
      at.z = 1;
      at.nz = -1;
      addSample(samples, at, SURFACE_CEILING, offset);
    }
  }
}

function addWallSamples(
  samples: LightSamples,
  at: SurfacePoint,
  world: TracedWorld,
  tileX: number,
  tileY: number
): void {
  for (const [side, normalX] of FACE_NORMAL_X.entries()) {
    const faceIndex = world.faceIndex[(tileY * world.width + tileX) * 4 + side] ?? NO_FACE;
    if (faceIndex === NO_FACE) {
      continue;
    }
    const normalY = FACE_NORMAL_Y.at(side) ?? 0;
    for (let row = 0; row < WALL_HEIGHTS; row++) {
      for (let column = 0; column < WALL_COLUMNS; column++) {
        const acrossFace = (column + 0.5) / WALL_COLUMNS;
        const inFront = 0.5 + WALL_STANDOFF;
        at.x = normalX === 0 ? tileX + acrossFace : tileX + 0.5 + normalX * inFront;
        at.y = normalY === 0 ? tileY + acrossFace : tileY + 0.5 + normalY * inFront;
        at.z = wallSampleHeight(row);
        at.nx = normalX;
        at.ny = normalY;
        at.nz = 0;
        addSample(samples, at, SURFACE_WALL, wallSampleOffset(faceIndex, row, column));
      }
    }
  }
}
