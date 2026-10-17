// The bake: every light sample in the room, listed once, goes through one pass after another into the lightmaps
// (spec docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §3.2): the lamps' direct light, three passes of
// bounce light, then the finishing touches. The lamps never move, so it runs once, a slice per frame; `bakeLighting`
// yields the fraction done after each slice.

import { seeded } from '@zoom3d/shared';
import {
  FLOOR_CELLS,
  planeCellOffset,
  type TracedLightmaps,
  WALL_COLUMNS,
  WALL_HEIGHTS,
  wallSampleHeight,
  wallSampleOffset,
} from './lightmaps';
import { clearBetween, createRay3, createRayHit3, HIT_CEILING, HIT_FLOOR, HIT_WALL, type RayHit3, trace } from './ray';
import {
  FACE_NORMAL_X,
  FACE_NORMAL_Y,
  isWall,
  LAMP_RADIUS,
  lampOver,
  NO_FACE,
  NO_LAMP,
  type TracedWorld,
} from './world';

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

/** Bounce passes: pass n lights each sample with what the lamps and pass n - 1 lit on the surfaces its rays reach. */
const BOUNCE_PASSES = 3;
/** Each sample's bounce rays go one to each cell of a RAY_GRID x RAY_GRID grid over the cosine-weighted hemisphere. */
const RAY_GRID = 4;
const BOUNCE_RAYS = RAY_GRID * RAY_GRID;
/** A bounce ray that meets nothing within this many tiles brings back nothing. */
const BOUNCE_REACH_TILES = 12;
/**
 * A bounce ray starts this far (tiles) from the floor and the ceiling: a wall sample on the floor or at the ceiling
 * would otherwise start on a surface it may point into, and `trace` would hit that surface at once.
 */
const RAY_START_MARGIN = 1e-3;
/** Bounce samples between yields: 128 take about as long as the direct pass's 512 (0.1 to 0.15 ms on LEVEL1). */
const BOUNCE_SAMPLES_PER_SLICE = 128;
/**
 * The bounce rays' jitter: the first draws of `seeded()`, read round and round, so two bakes of a world are the same.
 * A table, not calls: `seeded()` cost 40 ns a draw, nearly half the bake. 8192 is under the 11,000 or so draws after
 * which `seeded()` repeats, and a power of two, so a cursor wraps with a mask.
 */
const JITTER_SEED = 12345;
const JITTER_LENGTH = 8192;
const JITTER = Float64Array.from({ length: JITTER_LENGTH }, seeded(JITTER_SEED));

/** Cells each way the soft copy averages over; it does so twice, which makes the falloff a tent, not a box. */
const SOFT_REACH_CELLS = 4;
const SOFT_ROUNDS = 2;
/** Rounds of filling the cells inside wall tiles from the filled cells around them. */
const WALL_FILL_ROUNDS = 2;

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

/** One map's light while it bakes. */
interface MapLayers {
  /** The lamps' light. */
  direct: Float32Array;
  /** The bounce light of the last finished pass, which the next pass reads at the surfaces its rays hit. */
  bounce: Float32Array;
  /** The bounce light the pass under way is writing. */
  nextBounce: Float32Array;
  /** What the room draws meanwhile (a `TracedLightmaps` map): the lamps' light plus the newest bounce written so far. */
  shown: Float32Array;
}

/** The maps the samples light; SURFACE_* picks one. */
interface BakeLayers {
  floor: MapLayers;
  ceiling: MapLayers;
  wall: MapLayers;
}

/** What every pass shares. */
interface BakeState {
  world: TracedWorld;
  maps: TracedLightmaps;
  samples: LightSamples;
  layers: BakeLayers;
  /** Where in JITTER the next bounce ray's draw is: one stream through the whole bake. */
  jitterCursor: number;
}

/** Fills `maps` a slice at a time; each yield is the fraction of this pass done, 0..1, and the last is exactly 1. */
type BakePass = (bake: BakeState) => Generator<number, void, void>;

interface WeightedPass {
  run: BakePass;
  /** Its share of the whole bake, in any unit shared by the passes: what it costs, so the progress bar keeps pace. */
  weight: number;
}

/** In order. Weights are what each costs, measured on LEVEL1 in node (ms): a bounce pass is 4 to 5 direct passes. */
const BAKE_PASSES: readonly WeightedPass[] = [
  { run: bakeDirectLight, weight: 40 },
  ...Array.from({ length: BOUNCE_PASSES }, () => ({ run: bakeBounceLight, weight: 170 })),
  { run: finishLightmaps, weight: 35 },
];

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

/**
 * Fills `maps` with the room's light: the lamps', three passes of bounce on top, then the finishing touches. Yields the
 * fraction done, weighted by what each pass costs; the first yield, 0, comes once the samples are listed.
 */
export function* bakeLighting(world: TracedWorld, maps: TracedLightmaps): Generator<number, void, void> {
  const samples = listLightSamples(world);
  yield 0;
  const bake: BakeState = { world, maps, samples, layers: createBakeLayers(maps), jitterCursor: 0 };
  const totalWeight = BAKE_PASSES.reduce((total, { weight }) => total + weight, 0);
  let finishedWeight = 0;
  for (const { run, weight } of BAKE_PASSES) {
    for (const passDone of run(bake)) {
      yield (finishedWeight + passDone * weight) / totalWeight;
    }
    finishedWeight += weight;
  }
}

function createBakeLayers(maps: TracedLightmaps): BakeLayers {
  return {
    floor: createMapLayers(maps.floor),
    ceiling: createMapLayers(maps.ceiling),
    wall: createMapLayers(maps.wall),
  };
}

function createMapLayers(shown: Float32Array): MapLayers {
  return {
    direct: new Float32Array(shown.length),
    bounce: new Float32Array(shown.length),
    nextBounce: new Float32Array(shown.length),
    shown,
  };
}

function* bakeDirectLight(bake: BakeState): Generator<number, void, void> {
  const { world, samples, layers } = bake;
  for (let sample = 0; sample < samples.count; sample++) {
    loadSample(samples, sample, sampleScratch);
    lampLight(world, sampleScratch, lightScratch);
    const layer = layerOf(layers, samples.surface[sample] ?? SURFACE_FLOOR);
    const offset = samples.offset[sample] ?? 0;
    layer.direct.set(lightScratch, offset);
    layer.shown.set(lightScratch, offset);
    const done = sample + 1;
    if (done % SAMPLES_PER_SLICE === 0 || done === samples.count) {
      yield done / samples.count;
    }
  }
}

function layerOf(layers: BakeLayers, surface: number): MapLayers {
  switch (surface) {
    case SURFACE_CEILING:
      return layers.ceiling;
    case SURFACE_WALL:
      return layers.wall;
    default:
      return layers.floor;
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

const bounceRay = createRay3();
const bounceHit = createRayHit3();
const bounceScratch = new Float32Array(3);
/** A tile without a texture reflects nothing. */
const NO_ALBEDO = new Float32Array(3);

function* bakeBounceLight(bake: BakeState): Generator<number, void, void> {
  const { samples, layers } = bake;
  for (let sample = 0; sample < samples.count; sample++) {
    loadSample(samples, sample, sampleScratch);
    gatherBounce(bake, sampleScratch, bounceScratch);
    const layer = layerOf(layers, samples.surface[sample] ?? SURFACE_FLOOR);
    const offset = samples.offset[sample] ?? 0;
    for (let channel = 0; channel < 3; channel++) {
      const bounce = bounceScratch[channel] ?? 0;
      layer.nextBounce[offset + channel] = bounce;
      layer.shown[offset + channel] = (layer.direct[offset + channel] ?? 0) + bounce;
    }
    const done = sample + 1;
    if (done % BOUNCE_SAMPLES_PER_SLICE === 0 || done === samples.count) {
      yield done / samples.count;
    }
  }
  for (const layer of [layers.floor, layers.ceiling, layers.wall]) {
    swapBounce(layer);
  }
}

function swapBounce(layer: MapLayers): void {
  [layer.bounce, layer.nextBounce] = [layer.nextBounce, layer.bounce];
}

/**
 * The mean over the sample's rays of the light the surface each one hits throws back, into `out`: the rays are
 * cosine-weighted, so each counts the same. Allocates nothing per ray and reads typed arrays by index (`.at()` took 8x
 * as long in the direct pass).
 */
function gatherBounce(bake: BakeState, at: SurfacePoint, out: Float32Array): void {
  const { world } = bake;
  out.fill(0);
  // Two directions across the surface: on the floor and ceiling x and y, on a wall along it and up.
  const onWall = at.nz === 0;
  const firstX = onWall ? -at.ny : 1;
  const firstY = onWall ? at.nx : 0;
  const secondY = onWall ? 0 : 1;
  const secondZ = onWall ? 1 : 0;
  bounceRay.x = at.x;
  bounceRay.y = at.y;
  bounceRay.z = Math.min(1 - RAY_START_MARGIN, Math.max(RAY_START_MARGIN, at.z));
  // One turn of the strata per sample, so neighbouring samples don't share a pattern.
  const turn = nextJitter(bake);
  for (let row = 0; row < RAY_GRID; row++) {
    for (let column = 0; column < RAY_GRID; column++) {
      const radiusSquared = (column + nextJitter(bake)) / RAY_GRID;
      const angle = 2 * Math.PI * ((row + nextJitter(bake)) / RAY_GRID + turn);
      const radius = Math.sqrt(radiusSquared);
      const acrossFirst = radius * Math.cos(angle);
      const acrossSecond = radius * Math.sin(angle);
      const alongNormal = Math.sqrt(1 - radiusSquared);
      bounceRay.dx = firstX * acrossFirst + at.nx * alongNormal;
      bounceRay.dy = firstY * acrossFirst + secondY * acrossSecond + at.ny * alongNormal;
      bounceRay.dz = secondZ * acrossSecond + at.nz * alongNormal;
      addLightFrom(bake, trace(world, bounceRay, BOUNCE_REACH_TILES, bounceHit), out);
    }
  }
  for (let channel = 0; channel < 3; channel++) {
    out[channel] = (out[channel] ?? 0) / BOUNCE_RAYS;
  }
}

/** The next draw from JITTER, 0..1. */
function nextJitter(bake: BakeState): number {
  return JITTER[bake.jitterCursor++ & (JITTER_LENGTH - 1)] ?? 0;
}

/**
 * Adds into `out` the light the surface a ray hit throws back: the light at its nearest sample (the lamps' and the
 * last pass's) times the surface's colour in linear light. A ray that finds nothing, and one that ends on a lamp's disc,
 * whose light is the direct part, bring nothing.
 */
function addLightFrom(bake: BakeState, hit: RayHit3, out: Float32Array): void {
  const { world, layers } = bake;
  switch (hit.kind) {
    case HIT_WALL: {
      if (hit.faceIndex === NO_FACE) {
        return;
      }
      // `u` can round up to 1.
      const column = Math.min(WALL_COLUMNS - 1, Math.floor(hit.u * WALL_COLUMNS));
      const row = Math.round(hit.z * (WALL_HEIGHTS - 1));
      const albedo = world.meanAlbedo[hit.tile] ?? NO_ALBEDO;
      addSampleLight(out, layers.wall, wallSampleOffset(hit.faceIndex, row, column), albedo);
      return;
    }
    case HIT_FLOOR: {
      const offset = planeCellOffset(world, Math.floor(hit.x * FLOOR_CELLS), Math.floor(hit.y * FLOOR_CELLS));
      addSampleLight(out, layers.floor, offset, world.floorAlbedo);
      return;
    }
    case HIT_CEILING: {
      if (lampOver(world, hit.x, hit.y) !== NO_LAMP) {
        return;
      }
      const offset = planeCellOffset(world, Math.floor(hit.x * FLOOR_CELLS), Math.floor(hit.y * FLOOR_CELLS));
      addSampleLight(out, layers.ceiling, offset, world.ceilingAlbedo);
      return;
    }
  }
}

function addSampleLight(out: Float32Array, layer: MapLayers, offset: number, albedo: Float32Array): void {
  for (let channel = 0; channel < 3; channel++) {
    const lit = (layer.direct[offset + channel] ?? 0) + (layer.bounce[offset + channel] ?? 0);
    out[channel] = (out[channel] ?? 0) + lit * (albedo[channel] ?? 0);
  }
}

/**
 * The steps after the last bounce pass, each short enough for a frame's slice. The wall map needs none: the last pass
 * left it as the lamps' light plus bounce.
 */
function* finishLightmaps(bake: BakeState): Generator<number, void, void> {
  const { world, maps, layers } = bake;
  const openCells = openCellMask(world);
  const betweenBoxes = new Float32Array(maps.floor.length);
  const steps: readonly (() => void)[] = [
    () => smoothBounce(world, openCells, layers.floor),
    () => smoothBounce(world, openCells, layers.ceiling),
    () => showDirectAndBounce(layers.floor),
    () => showDirectAndBounce(layers.ceiling),
    () => maps.floorBounce.set(layers.floor.bounce),
    () => fillWallCells(world, openCells, maps.floor),
    () => fillWallCells(world, openCells, maps.floorBounce),
    () => fillWallCells(world, openCells, maps.ceiling),
    ...softCopySteps(world, maps.floor, maps.floorSoft, betweenBoxes),
    ...softCopySteps(world, maps.ceiling, maps.ceilingSoft, betweenBoxes),
  ];
  for (const [index, step] of steps.entries()) {
    step();
    yield (index + 1) / steps.length;
  }
}

/** Per floor or ceiling cell, 1 where the cell is in an open tile and 0 inside a wall tile. */
function openCellMask(world: TracedWorld): Uint8Array {
  const cellsAcross = world.width * FLOOR_CELLS;
  const open = new Uint8Array(cellsAcross * world.height * FLOOR_CELLS);
  for (let tileY = 0; tileY < world.height; tileY++) {
    for (let tileX = 0; tileX < world.width; tileX++) {
      if (!isWall(world, tileX, tileY)) {
        for (let row = 0; row < FLOOR_CELLS; row++) {
          const firstCell = (tileY * FLOOR_CELLS + row) * cellsAcross + tileX * FLOOR_CELLS;
          open.fill(1, firstCell, firstCell + FLOOR_CELLS);
        }
      }
    }
  }
  return open;
}

/** Bounce light is smooth, so a 3 x 3 mean over the open cells around each cell takes out the noise of 16 rays. */
function smoothBounce(world: TracedWorld, openCells: Uint8Array, layer: MapLayers): void {
  const cellsAcross = world.width * FLOOR_CELLS;
  const cellsDown = world.height * FLOOR_CELLS;
  for (let cellY = 0; cellY < cellsDown; cellY++) {
    for (let cellX = 0; cellX < cellsAcross; cellX++) {
      if (openCells[cellY * cellsAcross + cellX] === 1) {
        writeMeanOfUsable(layer.bounce, openCells, cellsAcross, cellsDown, cellX, cellY, layer.nextBounce);
      }
    }
  }
  swapBounce(layer);
}

/**
 * Writes the mean of the 3 x 3 cells around (cellX, cellY) that `usable` marks to the same cell of `into`, and says
 * whether there were any: if not, nothing is written.
 */
function writeMeanOfUsable(
  from: Float32Array,
  usable: Uint8Array,
  cellsAcross: number,
  cellsDown: number,
  cellX: number,
  cellY: number,
  into: Float32Array
): boolean {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = Math.max(0, cellY - 1); y <= Math.min(cellsDown - 1, cellY + 1); y++) {
    for (let x = Math.max(0, cellX - 1); x <= Math.min(cellsAcross - 1, cellX + 1); x++) {
      const neighbour = y * cellsAcross + x;
      if (usable[neighbour] === 1) {
        red += from[neighbour * 3] ?? 0;
        green += from[neighbour * 3 + 1] ?? 0;
        blue += from[neighbour * 3 + 2] ?? 0;
        count++;
      }
    }
  }
  if (count === 0) {
    return false;
  }
  const cell = (cellY * cellsAcross + cellX) * 3;
  into[cell] = red / count;
  into[cell + 1] = green / count;
  into[cell + 2] = blue / count;
  return true;
}

function showDirectAndBounce(layer: MapLayers): void {
  for (let at = 0; at < layer.shown.length; at++) {
    layer.shown[at] = (layer.direct[at] ?? 0) + (layer.bounce[at] ?? 0);
  }
}

/**
 * Cells inside wall tiles take the mean of the filled cells around them, a ring a round, so blending next to a wall
 * never pulls in black. Everything that reads a floor or ceiling map near a wall depends on it.
 */
function fillWallCells(world: TracedWorld, openCells: Uint8Array, light: Float32Array): void {
  const cellsAcross = world.width * FLOOR_CELLS;
  const cellsDown = world.height * FLOOR_CELLS;
  const filled = openCells.slice();
  for (let round = 0; round < WALL_FILL_ROUNDS; round++) {
    const filledBefore = filled.slice();
    for (let cellY = 0; cellY < cellsDown; cellY++) {
      for (let cellX = 0; cellX < cellsAcross; cellX++) {
        const cell = cellY * cellsAcross + cellX;
        if (
          filledBefore[cell] === 0 &&
          writeMeanOfUsable(light, filledBefore, cellsAcross, cellsDown, cellX, cellY, light)
        ) {
          filled[cell] = 1;
        }
      }
    }
  }
}

/**
 * The floor or ceiling light averaged over about a tile, into `soft`: what a rough reflection's wide cone sees. A box of
 * SOFT_REACH_CELLS each way along the rows, then the columns, twice.
 */
export function makeSoftCopy(world: TracedWorld, sharp: Float32Array, soft: Float32Array): void {
  for (const step of softCopySteps(world, sharp, soft, new Float32Array(sharp.length))) {
    step();
  }
}

/** `makeSoftCopy` as one step per box pass (about 2 ms each on LEVEL1, against 8 for the lot), using `betweenBoxes`. */
function softCopySteps(
  world: TracedWorld,
  sharp: Float32Array,
  soft: Float32Array,
  betweenBoxes: Float32Array
): (() => void)[] {
  const cellsAcross = world.width * FLOOR_CELLS;
  const cellsDown = world.height * FLOOR_CELLS;
  const steps: (() => void)[] = [];
  for (let round = 0; round < SOFT_ROUNDS; round++) {
    const from = round === 0 ? sharp : soft;
    steps.push(() => {
      for (let cellY = 0; cellY < cellsDown; cellY++) {
        boxAverageLine(from, betweenBoxes, cellY * cellsAcross * 3, 3, cellsAcross);
      }
    });
    steps.push(() => {
      for (let cellX = 0; cellX < cellsAcross; cellX++) {
        boxAverageLine(betweenBoxes, soft, cellX * 3, cellsAcross * 3, cellsDown);
      }
    });
  }
  return steps;
}

/**
 * Along one line of `length` cells, `stride` floats apart from `start` (the first cell's red), each cell becomes the
 * mean of the cells within SOFT_REACH_CELLS of it, fewer at the ends. A running sum, so it costs the same however wide.
 */
function boxAverageLine(from: Float32Array, into: Float32Array, start: number, stride: number, length: number): void {
  for (let channel = 0; channel < 3; channel++) {
    let sum = 0;
    for (let cell = 0; cell <= Math.min(SOFT_REACH_CELLS, length - 1); cell++) {
      sum += from[start + cell * stride + channel] ?? 0;
    }
    for (let cell = 0; cell < length; cell++) {
      const cellsInBox = Math.min(length - 1, cell + SOFT_REACH_CELLS) - Math.max(0, cell - SOFT_REACH_CELLS) + 1;
      into[start + cell * stride + channel] = sum / cellsInBox;
      const entering = cell + SOFT_REACH_CELLS + 1;
      if (entering < length) {
        sum += from[start + entering * stride + channel] ?? 0;
      }
      const leaving = cell - SOFT_REACH_CELLS;
      if (leaving >= 0) {
        sum -= from[start + leaving * stride + channel] ?? 0;
      }
    }
  }
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
