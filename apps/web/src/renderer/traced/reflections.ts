// Reflections (spec docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §3.3): what the cone each
// reflecting point sends out meets, traced at 1/REFLECTION_SCALE of the frame each way, then widened to the frame's
// width for the composite. Off a wall the ray is mirrored once per column and walked; off the floor it keeps its
// column's direction, so it needs no walk. Lamps and people meet the cone in closed form; walls, floor and ceiling are
// seen through prefiltered texture and light, kept apart from what lies over them so that the cone can blur them across
// the samples (surface-blur.ts) before the lamps and people are laid back over. Off the floor, walls hide what lies
// past them softly across columns, as wide as the cone spreads sideways (occlusion.ts). Allocation-free.
import { castRay, createRayHit, type RayHit } from '@zoom3d/shared';
import { EYE_HEIGHT } from '../camera';
import type { Sprite } from '../sprites';
import { TEX } from '../textures';
import {
  type ConeAcrossMap,
  createNearbyThings,
  createThingsAlongRay,
  findThingsAlongRay,
  listNearbyLamps,
  type ThingsAlongRay,
} from './along-ray';
import { REFLECTION_SAMPLE_OFFSET, REFLECTION_SCALE, type TracedBuffers } from './buffers';
import { planeLight, type TracedLightmaps, WALL_HEIGHTS, wallColumnLight } from './lightmaps';
import { createLampsPastWalls, findLampsPastWalls, seeLampsFrom, softenWallDistances } from './occlusion';
import { blobWeight, type ConeSpread, type InPlaneAxis, spreadCone } from './optics';
import { createNearbyPeople, listNearbyPeople, seeDiscSharp } from './people';
import { faceEntered, texelColumnOf } from './primary';
import { FLOOR_SURFACE, NO_SURFACE, wallSurface } from './surface-blur';
import { FACE_NORMAL_X, FACE_NORMAL_Y, FLOOR_MATERIAL, NO_FACE, TRACED_MATERIALS, type TracedWorld } from './world';

/** A cone's narrowing across its plane of incidence stops at this slant (the cosine between the view and the normal). */
const MIN_SLANT = 0.1;
/** A lamp's stretch along the ray stops growing at this rise (the sine of the ray's climb to the ceiling). */
const MIN_RISE = 0.1;
/** Even a mirror blends an edge over this much height (tiles): a little anti-aliasing. */
const MIN_EDGE_TILES = 0.02;
/** A texture fades to its average colour as the cone grows to this wide (tiles: about a brick's height). */
const TEXTURE_DETAIL_TILES = 0.25;
/** The floor and ceiling's soft light takes over as the cone grows to this wide (tiles). */
const LIGHT_DETAIL_TILES = 1;
/** Past this cone width per tile, what a wall reflects barely changes from one sample row to the next... */
const ROUGH_WALL_CONE_PER_TILE = 0.25;
/** ...so on a wall that rough only every this many sample rows are traced, and the rows between blended. */
const ROUGH_WALL_ROW_STEP = 4;
/** A mirrored ray starts this far (tiles) out from the wall it leaves. */
const OFF_THE_WALL = 1e-4;
/** The spans between a face's sample heights. */
const WALL_SEGMENTS = WALL_HEIGHTS - 1;
/** How wide (tiles) the floor's cone grows per tile travelled: its roughness squared. */
const FLOOR_CONE_PER_TILE = FLOOR_MATERIAL.roughness * FLOOR_MATERIAL.roughness;
/**
 * How wide (tiles) the floor's cone is across the view where it reaches the ceiling, a tile up, as the lamps and a
 * wall's top are: it grows FLOOR_CONE_PER_TILE per tile travelled and narrows across by the slant, which is its climb
 * per tile, so it is FLOOR_CONE_PER_TILE wide across per tile climbed, from any row (until the slant is held at
 * MIN_SLANT, near the horizon). What walls hide off the floor is softened across columns by this width.
 */
const FLOOR_CONE_ACROSS_AT_CEILING = FLOOR_CONE_PER_TILE;
/** A person's disc shows sharp, with its face, while the cone is narrower than this many of its radii. */
const SHARP_CONE_RADII = 0.3;

const NO_TEXTURE = new Float32Array(0);

/** The frame column a reflection column is traced for: its ray, as the primary pass casts it, and the wall it meets. */
interface ReflectingColumn {
  col: number;
  rayX: number;
  rayY: number;
  /** The ray's length: the tiles a unit along it crosses. */
  run: number;
  /** To the wall, in units of the ray (perpendicular to the camera plane); Infinity where none is in reach. */
  distance: number;
  /** The face (FACE_*) the ray meets, and how squarely: |n · ray|. */
  face: number;
  facing: number;
  /** The wall plane that face lies in, as a surface kind (surface-blur.ts): what its reflections are blurred among. */
  surface: number;
}

/** A wall as a reflection sees it, up the column its ray meets. */
interface WallSeen {
  /** 0 where no wall is in reach. */
  tile: number;
  texX: number;
  /** Its texture and that texture's average colour, in linear light. */
  albedo: Float32Array;
  mean: Float32Array;
  /** The light up the column at the face's sample heights, r, g, b from the floor up. */
  light: Float32Array;
}

/** A reflected ray and the cone around it: aimed per column, then per sample row. */
interface Reflection extends ConeAcrossMap {
  /** Its ray runs from (x, y) along (dx, dy), crossing `run` tiles per unit s. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  run: number;
  /**
   * How deep (s) the eye's ray has come by s = 0 along this one: off a wall the wall's distance, off the floor 0, since
   * that ray starts at the eye. A thing `s` along it shows in the reflection as deep as eyeS + s.
   */
  eyeS: number;
  /** Reflection samples per tile at a depth of 1 (tiles): what turns the cone's width where it lands into samples. */
  samplesPerTile: number;
  /** The cone's widths across the view and up it per tile of its width, as mirror geometry spreads it at `slant`. */
  shape: ConeSpread;
  /** Where along the ray (s) the cone leaves its surface, at what height (tiles), climbing `rise` per unit s. */
  fromS: number;
  fromHeight: number;
  rise: number;
  /** How wide (tiles) the cone grows per tile travelled: the surface's roughness squared. */
  conePerTile: number;
  /** How squarely the eye's ray meets the surface, held at MIN_SLANT: the cone narrows by it across... */
  slant: number;
  /** ...its plane of incidence, keeping its width along this axis of the view. */
  inPlane: InPlaneAxis;
  /** The wall the ray meets, `wallS` along it (Infinity where none is in reach). */
  wall: WallSeen;
  wallS: number;
  /**
   * Where the share of the cone that meets the wall, rather than passing its top or foot, is reckoned: off the floor
   * the wall's distance softened across columns, so a jump in depth fades over the cone's width; off a wall `wallS`.
   */
  shareWallS: number;
  /** How wide (tiles) the cone grows to each side per unit s, at eye level: what things near the ray are found by. */
  spreadPerS: number;
  /** The lamps and the people near the ray. */
  lamps: ThingsAlongRay;
  people: ThingsAlongRay;
}

const column: ReflectingColumn = { col: 0, rayX: 0, rayY: 0, run: 1, distance: 0, face: 0, facing: 0, surface: 0 };
const columnWall = createWallSeen();
const farWall = createWallSeen();
const offFloor = createReflection(columnWall, 'up', FLOOR_CONE_PER_TILE);
/** Its cone's width per tile is the column's wall's, set per column. */
const offWall = createReflection(farWall, 'across', 0);

const columnHit = createRayHit();
const mirrorHit = createRayHit();
const nearbyLamps = createNearbyThings();
const nearbyPeople = createNearbyPeople();
const lampsPastWalls = createLampsPastWalls();

/**
 * What a reflection sample sees, linear light: the walls, floor and ceiling its cone meets, and the cone's width where
 * it meets them over the depth the reflection shows them at, weighed by their shares: what they are blurred by...
 */
const surfaces = { red: 0, green: 0, blue: 0, conePerDepth: 0 };
/** ...and the lamps and people over them: `keeps` of the surfaces shows through, and r, g, b add to it. */
const over = { red: 0, green: 0, blue: 0, keeps: 1 };
/** One surface the cone meets, before it is weighed in. */
const part = { red: 0, green: 0, blue: 0 };
const spread: ConeSpread = { across: 0, up: 0 };
const planeSample = new Float32Array(3);

/**
 * Fills the reflection samples: per sample, what the cone off the surface it shows meets, `people` among it (the
 * ceiling is matte and reflects nothing), kept as the walls, floor and ceiling (`reflectedSurface`, with the cone's
 * width there) and what lies over them (`reflectedKeep`, `reflectedOver`). Needs the rows each column's wall covers,
 * from the primary pass. `layOverBlurredSurfaces` puts them together once the surfaces are blurred.
 */
export function traceReflections(
  buffers: TracedBuffers,
  world: TracedWorld,
  maps: TracedLightmaps,
  people: readonly Sprite[]
): void {
  const { reflectedWidth, reflectedHeight, view } = buffers;
  listNearbyLamps(world, view.x, view.y, nearbyLamps);
  listNearbyPeople(people, view.x, view.y, nearbyPeople);
  seeWallsAcrossColumns(buffers);
  offFloor.samplesPerTile = view.proj / REFLECTION_SCALE;
  offWall.samplesPerTile = view.proj / REFLECTION_SCALE;
  for (let sampleCol = 0; sampleCol < reflectedWidth; sampleCol++) {
    aimColumn(buffers, world, maps, sampleCol);
    const wallTop = firstSampleRowFrom(buffers.wallStart[column.col] ?? 0, reflectedHeight);
    const floorTop = Math.max(wallTop, firstSampleRowFrom(buffers.wallEnd[column.col] ?? 0, reflectedHeight));
    clearCeilingSamples(buffers, sampleCol, wallTop);
    if (floorTop > wallTop) {
      mirrorOffWall(buffers, world, maps);
      traceWallSamples(buffers, world, maps, sampleCol, wallTop, floorTop);
    }
    traceFloorSamples(buffers, world, maps, sampleCol, floorTop);
  }
}

/**
 * Lays the lamps and people back over the blurred surfaces, into `reflected`: per sample, what they leave showing of
 * `blurredSurface` plus `reflectedOver`. The ceiling reflects nothing, but the composite blends a wall's top pixel row
 * with the sample row above it: holding the wall's first sample there keeps that row from losing part of its
 * reflection to black.
 */
export function layOverBlurredSurfaces(buffers: TracedBuffers): void {
  const { reflected, blurredSurface, reflectedKeep, reflectedOver } = buffers;
  for (let sample = 0; sample < reflectedKeep.length; sample++) {
    const keeps = reflectedKeep[sample] ?? 0;
    const at = sample * 3;
    reflected[at] = keeps * (blurredSurface[at] ?? 0) + (reflectedOver[at] ?? 0);
    reflected[at + 1] = keeps * (blurredSurface[at + 1] ?? 0) + (reflectedOver[at + 1] ?? 0);
    reflected[at + 2] = keeps * (blurredSurface[at + 2] ?? 0) + (reflectedOver[at + 2] ?? 0);
  }
  for (let sampleCol = 0; sampleCol < buffers.reflectedWidth; sampleCol++) {
    holdFirstWallSampleUp(buffers, sampleCol);
  }
}

/** Blends each row of `reflected` out to the frame's width, into `widenedReflection`. */
export function widenReflections(buffers: TracedBuffers): void {
  const { width, reflectedWidth, reflectedHeight, reflected, widenedReflection } = buffers;
  const { before, towardsNext } = buffers.reflectionColumns;
  for (let sampleRow = 0; sampleRow < reflectedHeight; sampleRow++) {
    const sampleRowAt = sampleRow * reflectedWidth * 3;
    const widenedRowAt = sampleRow * width * 3;
    for (let col = 0; col < width; col++) {
      const share = towardsNext[col] ?? 0;
      const left = sampleRowAt + (before[col] ?? 0) * 3;
      const out = widenedRowAt + col * 3;
      const leftRed = reflected[left] ?? 0;
      const leftGreen = reflected[left + 1] ?? 0;
      const leftBlue = reflected[left + 2] ?? 0;
      widenedReflection[out] = leftRed + ((reflected[left + 3] ?? 0) - leftRed) * share;
      widenedReflection[out + 1] = leftGreen + ((reflected[left + 4] ?? 0) - leftGreen) * share;
      widenedReflection[out + 2] = leftBlue + ((reflected[left + 5] ?? 0) - leftBlue) * share;
    }
  }
}

/**
 * Each tile id's reflection colour into `out` (r, g, b per tile id): white, blended by its material's tint towards its
 * own average colour at full strength. The floor's tint is 0: it reflects the light as it is.
 */
export function fillReflectionTints(world: TracedWorld, out: Float32Array): void {
  for (let tile = 0; tile < TRACED_MATERIALS.length; tile++) {
    const tint = TRACED_MATERIALS[tile]?.tint ?? 0;
    const mean = tile === 0 ? world.floorAlbedo : (world.meanAlbedo[tile] ?? world.floorAlbedo);
    const brightest = Math.max(mean[0] ?? 0, mean[1] ?? 0, mean[2] ?? 0) || 1;
    for (let channel = 0; channel < 3; channel++) {
      out[tile * 3 + channel] = 1 - tint + (tint * (mean[channel] ?? 0)) / brightest;
    }
  }
}

function createWallSeen(): WallSeen {
  return { tile: 0, texX: 0, albedo: NO_TEXTURE, mean: NO_TEXTURE, light: new Float32Array(WALL_HEIGHTS * 3) };
}

function createReflection(wall: WallSeen, inPlane: InPlaneAxis, conePerTile: number): Reflection {
  return {
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    run: 1,
    eyeS: 0,
    samplesPerTile: 0,
    shape: { across: 0, up: 0 },
    fromS: 0,
    fromHeight: 0,
    rise: 0,
    conePerTile,
    slant: 1,
    inPlane,
    wall,
    wallS: 0,
    shareWallS: 0,
    spreadPerS: 0,
    lamps: createThingsAlongRay(),
    people: createThingsAlongRay(),
  };
}

/**
 * Lists what the floor's reflections read to soften wall occlusion across columns (occlusion.ts): each reflection
 * column's wall distance and that softened, and per lamp near the eye the columns whose wall lies beyond it.
 */
function seeWallsAcrossColumns(buffers: TracedBuffers): void {
  const { reflectedWidth, reflectedWallDistance, softWallDistance, wallDistance, view } = buffers;
  for (let sampleCol = 0; sampleCol < reflectedWidth; sampleCol++) {
    reflectedWallDistance[sampleCol] =
      wallDistance[sampleCol * REFLECTION_SCALE + REFLECTION_SAMPLE_OFFSET] ?? Number.POSITIVE_INFINITY;
  }
  const columnsPerTile = view.proj / REFLECTION_SCALE;
  softenWallDistances(reflectedWallDistance, columnsPerTile, FLOOR_CONE_ACROSS_AT_CEILING, softWallDistance);
  findLampsPastWalls(
    nearbyLamps,
    view,
    reflectedWallDistance,
    columnsPerTile,
    FLOOR_CONE_ACROSS_AT_CEILING,
    lampsPastWalls
  );
}

/** The first sample row at or below frame row `frameRow`, or `samples` if none is. */
function firstSampleRowFrom(frameRow: number, samples: number): number {
  return Math.min(samples, Math.max(0, Math.ceil((frameRow - REFLECTION_SAMPLE_OFFSET) / REFLECTION_SCALE)));
}

function frameRowOf(sampleRow: number): number {
  return sampleRow * REFLECTION_SCALE + REFLECTION_SAMPLE_OFFSET;
}

/**
 * Casts the frame column that sample column `sampleCol` is traced for, with the primary pass's ray, into `column` and
 * `columnWall`, and aims `offFloor` along it: off the floor the ray keeps its column's direction, and its cone sees
 * past the walls by what falls on the columns it spreads over.
 */
function aimColumn(buffers: TracedBuffers, world: TracedWorld, maps: TracedLightmaps, sampleCol: number): void {
  const { x, y, dirX, dirY, planeX, planeY } = buffers.view;
  const col = sampleCol * REFLECTION_SCALE + REFLECTION_SAMPLE_OFFSET;
  const cameraX = (2 * col) / buffers.width - 1;
  const rayX = dirX + planeX * cameraX;
  const rayY = dirY + planeY * cameraX;
  castRay(world.map, x, y, rayX, rayY, columnHit);
  const face = faceEntered(columnHit, rayX, rayY);
  column.col = col;
  column.rayX = rayX;
  column.rayY = rayY;
  column.run = Math.sqrt(rayX * rayX + rayY * rayY);
  column.distance = columnHit.distance;
  column.face = face;
  column.facing = Math.abs((FACE_NORMAL_X[face] ?? 0) * rayX + (FACE_NORMAL_Y[face] ?? 0) * rayY);
  column.surface = wallSurface(face, FACE_NORMAL_X[face] === 0 ? columnHit.mapY : columnHit.mapX);
  seeWallHit(world, maps, columnHit, rayX, rayY, columnWall);

  offFloor.x = x;
  offFloor.y = y;
  offFloor.dx = rayX;
  offFloor.dy = rayY;
  offFloor.run = column.run;
  offFloor.wallS = column.distance;
  offFloor.shareWallS = buffers.softWallDistance[sampleCol] ?? column.distance;
  offFloor.spreadPerS = FLOOR_CONE_PER_TILE * column.run;
  seeLampsFrom(lampsPastWalls, sampleCol);
  findThingsAlong(offFloor, lampsPastWalls.shown);
}

/**
 * The lamps and the people `reflection`'s cone can meet, each nearest first: the lamps by how much of each it sees past
 * the walls, `lampsSeenPastWalls`, if given, else those before its wall.
 */
function findThingsAlong(reflection: Reflection, lampsSeenPastWalls?: Float64Array): void {
  findThingsAlongRay(nearbyLamps, reflection, reflection.lamps, lampsSeenPastWalls);
  findThingsAlongRay(nearbyPeople, reflection, reflection.people);
}

/** The wall castRay's `hit` met, as a reflection sees it, into `out`. */
function seeWallHit(
  world: TracedWorld,
  maps: TracedLightmaps,
  hit: RayHit,
  rayX: number,
  rayY: number,
  out: WallSeen
): void {
  const face = faceEntered(hit, rayX, rayY);
  const faceIndex =
    hit.tile === 0 ? NO_FACE : (world.faceIndex[(hit.mapY * world.width + hit.mapX) * 4 + face] ?? NO_FACE);
  out.tile = hit.tile;
  out.texX = texelColumnOf(hit, rayX, rayY);
  out.albedo = world.albedo[hit.tile] ?? NO_TEXTURE;
  out.mean = world.meanAlbedo[hit.tile] ?? NO_TEXTURE;
  wallColumnLight(maps, faceIndex, hit.wallX, out.light);
}

/** The ceiling's samples above `wallTop`: it reflects nothing, and is no surface the blur takes in. */
function clearCeilingSamples(buffers: TracedBuffers, sampleCol: number, wallTop: number): void {
  for (let sampleRow = 0; sampleRow < wallTop; sampleRow++) {
    const sample = sampleRow * buffers.reflectedWidth + sampleCol;
    for (let at = sample * 3; at < sample * 3 + 3; at++) {
      buffers.reflectedSurface[at] = 0;
      buffers.reflectedOver[at] = 0;
    }
    buffers.reflectedKeep[sample] = 0;
    buffers.coneAcross[sample] = 0;
    buffers.coneUp[sample] = 0;
    buffers.surfaceKind[sample] = NO_SURFACE;
  }
}

/** Copies column `sampleCol`'s first sample up the ceiling rows above it, if it is a wall's. */
function holdFirstWallSampleUp(buffers: TracedBuffers, sampleCol: number): void {
  const { reflected, reflectedWidth, reflectedHeight, surfaceKind } = buffers;
  let wallTop = 0;
  while (wallTop < reflectedHeight && surfaceKind[wallTop * reflectedWidth + sampleCol] === NO_SURFACE) {
    wallTop++;
  }
  if (wallTop === reflectedHeight || surfaceKind[wallTop * reflectedWidth + sampleCol] === FLOOR_SURFACE) {
    return;
  }
  const first = (wallTop * reflectedWidth + sampleCol) * 3;
  for (let sampleRow = 0; sampleRow < wallTop; sampleRow++) {
    const at = (sampleRow * reflectedWidth + sampleCol) * 3;
    reflected[at] = reflected[first] ?? 0;
    reflected[at + 1] = reflected[first + 1] ?? 0;
    reflected[at + 2] = reflected[first + 2] ?? 0;
  }
}

// Off the column's wall.

/** Mirrors the column's ray off its wall and walks it: `offWall` and the far wall it meets, `farWall`. */
function mirrorOffWall(buffers: TracedBuffers, world: TracedWorld, maps: TracedLightmaps): void {
  const { rayX, rayY, run, distance, face } = column;
  const normalX = FACE_NORMAL_X[face] ?? 0;
  const normalY = FACE_NORMAL_Y[face] ?? 0;
  offWall.x = buffers.view.x + rayX * distance + normalX * OFF_THE_WALL;
  offWall.y = buffers.view.y + rayY * distance + normalY * OFF_THE_WALL;
  offWall.eyeS = distance;
  offWall.dx = normalX === 0 ? rayX : -rayX;
  offWall.dy = normalY === 0 ? rayY : -rayY;
  offWall.run = run;
  castRay(world.map, offWall.x, offWall.y, offWall.dx, offWall.dy, mirrorHit);
  seeWallHit(world, maps, mirrorHit, offWall.dx, offWall.dy, farWall);
  offWall.wallS = mirrorHit.distance;
  offWall.shareWallS = mirrorHit.distance;

  const roughness = (TRACED_MATERIALS[columnWall.tile] ?? FLOOR_MATERIAL).roughness;
  offWall.conePerTile = roughness * roughness;
  // The things the cone can reach to the side, as wide across as at eye level: up to 7% more at the frame's top or
  // bottom, where the ray climbs or falls, which three spreads leave room for.
  offWall.spreadPerS = offWall.conePerTile * run;
  findThingsAlong(offWall);
}

/**
 * The wall's samples from `wallTop` to `floorTop`. What a rough wall reflects barely changes from row to row, so there
 * only every ROUGH_WALL_ROW_STEP-th row and the last are traced, and the rows between blended.
 */
function traceWallSamples(
  buffers: TracedBuffers,
  world: TracedWorld,
  maps: TracedLightmaps,
  sampleCol: number,
  wallTop: number,
  floorTop: number
): void {
  const step = offWall.conePerTile > ROUGH_WALL_CONE_PER_TILE ? ROUGH_WALL_ROW_STEP : 1;
  const lastRow = floorTop - 1;
  let tracedRow = -1;
  for (let sampleRow = wallTop; tracedRow < lastRow; sampleRow = Math.min(lastRow, sampleRow + step)) {
    aimOffWall(buffers, frameRowOf(sampleRow));
    seeAlong(offWall, world, maps);
    keepSeen(buffers, offWall, sampleCol, sampleRow, column.surface);
    blendSamplesBetween(buffers, sampleCol, tracedRow, sampleRow);
    tracedRow = sampleRow;
  }
}

/** Aims `offWall` at frame row `frameRow`: the mirrored ray climbs as the eye's ray does, from where it met the wall. */
function aimOffWall(buffers: TracedBuffers, frameRow: number): void {
  const { proj, half } = buffers.view;
  const rise = (half - (frameRow + 0.5)) / proj;
  offWall.rise = rise;
  offWall.fromHeight = clampToUnit(EYE_HEIGHT + rise * column.distance);
  offWall.slant = Math.max(MIN_SLANT, column.facing / Math.sqrt(column.run * column.run + rise * rise));
  spreadCone(1, offWall.slant, offWall.inPlane, offWall.shape);
}

// Off the floor.

/** The floor's samples from `floorTop` to the bottom of the frame. */
function traceFloorSamples(
  buffers: TracedBuffers,
  world: TracedWorld,
  maps: TracedLightmaps,
  sampleCol: number,
  floorTop: number
): void {
  for (let sampleRow = floorTop; sampleRow < buffers.reflectedHeight; sampleRow++) {
    aimOffFloor(buffers, frameRowOf(sampleRow));
    seeAlong(offFloor, world, maps);
    keepSeen(buffers, offFloor, sampleCol, sampleRow, FLOOR_SURFACE);
  }
}

/** Aims `offFloor` at frame row `frameRow`: from where the eye's ray meets the floor, climbing as steeply as it fell. */
function aimOffFloor(buffers: TracedBuffers, frameRow: number): void {
  const floorS = buffers.rowDistance[frameRow] ?? 0;
  const rise = EYE_HEIGHT / floorS;
  offFloor.fromS = floorS;
  offFloor.rise = rise;
  offFloor.slant = Math.max(MIN_SLANT, rise / Math.sqrt(offFloor.run * offFloor.run + rise * rise));
  spreadCone(1, offFloor.slant, offFloor.inPlane, offFloor.shape);
}

// What a cone sees.

/** What `reflection`'s cone meets, into `surfaces` and `over`: the room, and the people in front of it. */
function seeAlong(reflection: Reflection, world: TracedWorld, maps: TracedLightmaps): void {
  seeRoom(reflection, world, maps);
  // Asked here too: V8 stopped inlining seePeople into this path, and most samples have nobody to see.
  if (reflection.people.count > 0) {
    seePeople(reflection);
  }
}

/**
 * The room `reflection`'s cone meets: its wall, or the floor or ceiling past the wall's foot or top, the two blended
 * where the cone straddles the edge, into `surfaces` with the cone's width where it meets them; and the lamps where it
 * reaches the ceiling, into `over`.
 */
function seeRoom(reflection: Reflection, world: TracedWorld, maps: TracedLightmaps): void {
  const { fromS, fromHeight, rise, run, conePerTile, wall } = reflection;
  const wallShare = wall.tile === 0 ? 0 : wallShareOf(reflection);
  clearSeen();
  if (wallShare > 0) {
    const toWall = Math.max(0, reflection.wallS - fromS);
    seeWall(wall, clampToUnit(fromHeight + rise * toWall), conePerTile * toWall * run);
    addPart(reflection, toWall, wallShare);
  }
  if (wallShare === 1 || rise === 0) {
    return;
  }
  const upward = rise > 0;
  // Where the ray meets the wall first, the part of the cone that passes its foot or top meets the plane in front of
  // it: the ray's own crossing lies beyond the wall, often in another room, and lit by other lamps.
  const planeS = Math.max(fromS, Math.min(reflection.wallS, fromS + (upward ? 1 - fromHeight : -fromHeight) / rise));
  seePlane(
    world,
    upward ? maps.ceiling : maps.floor,
    upward ? maps.ceilingSoft : maps.floorSoft,
    upward ? world.ceilingAlbedo : world.floorAlbedo,
    reflection.x + reflection.dx * planeS,
    reflection.y + reflection.dy * planeS,
    conePerTile * (planeS - fromS) * run
  );
  addPart(reflection, planeS - fromS, 1 - wallShare);
  if (upward) {
    addLampsAtCeiling(world, reflection, planeS, 1 - wallShare);
  }
}

/**
 * How much of `reflection`'s cone meets its wall, rather than the floor below its foot or the ceiling above its top,
 * reckoned at `shareWallS`: the two blend over the cone's width up the view there. A rising ray (`rise` > 0) can only
 * pass the top, a falling one the foot.
 */
function wallShareOf(reflection: Reflection): number {
  const { fromS, fromHeight, rise } = reflection;
  const toWall = Math.max(0, reflection.shareWallS - fromS);
  spreadCone(reflection.conePerTile * toWall * reflection.run, reflection.slant, reflection.inPlane, spread);
  const edge = Math.max(MIN_EDGE_TILES, spread.up);
  const height = fromHeight + rise * toWall;
  if (rise > 0) {
    return clampToUnit((1 + edge - height) / (2 * edge));
  }
  if (rise < 0) {
    return clampToUnit((height + edge) / (2 * edge));
  }
  return 1;
}

/**
 * A wall seen through a cone `cone` tiles wide at `height` up it, into `part`: its texture fades to its average colour
 * as the cone outgrows a brick.
 */
function seeWall(wall: WallSeen, height: number, cone: number): void {
  const { albedo, mean, light } = wall;
  const texel = (Math.min(TEX - 1, ((1 - height) * TEX) | 0) * TEX + wall.texX) * 3;
  const toMean = cone >= TEXTURE_DETAIL_TILES ? 1 : cone / TEXTURE_DETAIL_TILES;
  const scaled = height * WALL_SEGMENTS;
  const below = scaled >= WALL_SEGMENTS ? WALL_SEGMENTS - 1 : scaled | 0;
  const above = scaled - below;
  const at = below * 3;
  part.red = mix(albedo[texel], mean[0], toMean) * mix(light[at], light[at + 3], above);
  part.green = mix(albedo[texel + 1], mean[1], toMean) * mix(light[at + 1], light[at + 4], above);
  part.blue = mix(albedo[texel + 2], mean[2], toMean) * mix(light[at + 2], light[at + 5], above);
}

/**
 * The floor or ceiling at (x, y) seen through a cone `cone` tiles wide, into `part`: its light gives way to its soft
 * copy as the cone grows.
 */
function seePlane(
  world: TracedWorld,
  light: Float32Array,
  soft: Float32Array,
  albedo: Float32Array,
  x: number,
  y: number,
  cone: number
): void {
  const toSoft = cone >= LIGHT_DETAIL_TILES ? 1 : cone / LIGHT_DETAIL_TILES;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (toSoft < 1) {
    planeLight(light, world, x, y, planeSample);
    red = (planeSample[0] ?? 0) * (1 - toSoft);
    green = (planeSample[1] ?? 0) * (1 - toSoft);
    blue = (planeSample[2] ?? 0) * (1 - toSoft);
  }
  if (toSoft > 0) {
    planeLight(soft, world, x, y, planeSample);
    red += (planeSample[0] ?? 0) * toSoft;
    green += (planeSample[1] ?? 0) * toSoft;
    blue += (planeSample[2] ?? 0) * toSoft;
  }
  part.red = (albedo[0] ?? 0) * red;
  part.green = (albedo[1] ?? 0) * green;
  part.blue = (albedo[2] ?? 0) * blue;
}

/**
 * Adds to `over` the lamps `reflection`'s cone meets where it reaches the ceiling, at `ceilingS` along its ray, with
 * `share` of it getting there: each disc against the cone's footprint, as a blob. The footprint is the cone's spread,
 * its width up the view stretched along the ray by how low the ray comes in (1 / its rise), which turns a lamp far down
 * a corridor into a streak.
 */
function addLampsAtCeiling(world: TracedWorld, reflection: Reflection, ceilingS: number, share: number): void {
  const { fromS, rise, run, lamps } = reflection;
  const length = Math.sqrt(run * run + rise * rise);
  const cone = reflection.conePerTile * (ceilingS - fromS) * length;
  const comesIn = Math.max(MIN_RISE, rise / length);
  spreadCone(cone, reflection.slant, reflection.inPlane, spread);
  const spreadAcross = spread.across;
  const spreadAlong = spread.up / comesIn;
  let lampShare = 0;
  for (let at = 0; at < lamps.count; at++) {
    const lampS = lamps.s[at] ?? 0;
    if (lampS <= fromS) {
      continue;
    }
    const radius = nearbyLamps.radius[lamps.thing[at] ?? 0] ?? 0;
    const blob = blobWeight(lamps.side[at] ?? 0, (lampS - ceilingS) * run, radius, spreadAcross, spreadAlong);
    lampShare += blob * (lamps.shown[at] ?? 0);
  }
  over.red += (world.lampRgb[0] ?? 0) * lampShare * share;
  over.green += (world.lampRgb[1] ?? 0) * lampShare * share;
  over.blue += (world.lampRgb[2] ?? 0) * lampShare * share;
}

/**
 * Lays over what `reflection`'s cone sees the people it meets, far to near, each covering what is behind (in `over`, as
 * how much of the surfaces it leaves and what it adds to them): sharp while the cone is narrower than SHARP_CONE_RADII
 * of a disc's radius, else the disc blurred by the cone (spread as for the lamps), a blob of what a blurred disc shows.
 */
function seePeople(reflection: Reflection): void {
  const { fromS, fromHeight, rise, run, slant, inPlane, people } = reflection;
  if (people.count === 0) {
    return;
  }
  const conePerS = reflection.conePerTile * Math.sqrt(run * run + rise * rise);
  for (let at = people.count - 1; at >= 0; at--) {
    const personS = people.s[at] ?? 0;
    if (personS <= fromS) {
      continue;
    }
    const person = people.thing[at] ?? 0;
    const radius = nearbyPeople.radius[person] ?? 0;
    // The disc's centre lies `side` to the ray's right, so the ray meets the disc that far to the centre's left.
    const across = -(people.side[at] ?? 0);
    const up = fromHeight + rise * (personS - fromS) - (nearbyPeople.height[person] ?? 0);
    const cone = conePerS * (personS - fromS);
    if (cone >= SHARP_CONE_RADII * radius) {
      spreadCone(cone, slant, inPlane, spread);
      layBlurredDiscOver(person, blobWeight(across, up, radius, spread.across, spread.up));
    } else if (across * across + up * up < radius * radius) {
      seeDiscSharp(nearbyPeople, person, across / radius, up / radius, over);
      over.keeps = 0;
    }
  }
}

/** Lays person `person`'s disc, blurred, over what the cone sees, covering `weight` of it. */
function layBlurredDiscOver(person: number, weight: number): void {
  if (weight === 0) {
    return;
  }
  const keeps = 1 - weight;
  over.red = over.red * keeps + (nearbyPeople.blurred[person * 3] ?? 0) * weight;
  over.green = over.green * keeps + (nearbyPeople.blurred[person * 3 + 1] ?? 0) * weight;
  over.blue = over.blue * keeps + (nearbyPeople.blurred[person * 3 + 2] ?? 0) * weight;
  over.keeps *= keeps;
}

// The samples.

function clearSeen(): void {
  surfaces.red = 0;
  surfaces.green = 0;
  surfaces.blue = 0;
  surfaces.conePerDepth = 0;
  over.red = 0;
  over.green = 0;
  over.blue = 0;
  over.keeps = 1;
}

/**
 * Adds `share` of `part`, a surface `toSurface` along `reflection`, to `surfaces`, and as much of the width of the cone
 * where it meets it over the depth the reflection shows it at. One call for both: each call on the room's per-sample
 * path counts against V8's inlining budget.
 */
function addPart(reflection: Reflection, toSurface: number, share: number): void {
  surfaces.red += part.red * share;
  surfaces.green += part.green * share;
  surfaces.blue += part.blue * share;
  surfaces.conePerDepth +=
    (share * reflection.conePerTile * toSurface * reflection.run) / (reflection.eyeS + reflection.fromS + toSurface);
}

/**
 * Keeps what `reflection`'s cone saw as sample (`sampleCol`, `sampleRow`), off surface kind `kind`, with the deviation
 * in samples along the row and the column that its surfaces are blurred by: the cone's width over their depth, spread
 * by mirror geometry (spreadCone is linear in the width), in samples.
 */
function keepSeen(
  buffers: TracedBuffers,
  reflection: Reflection,
  sampleCol: number,
  sampleRow: number,
  kind: number
): void {
  const sample = sampleRow * buffers.reflectedWidth + sampleCol;
  const at = sample * 3;
  const coneSamples = surfaces.conePerDepth * reflection.samplesPerTile;
  buffers.reflectedSurface[at] = surfaces.red;
  buffers.reflectedSurface[at + 1] = surfaces.green;
  buffers.reflectedSurface[at + 2] = surfaces.blue;
  buffers.coneAcross[sample] = coneSamples * reflection.shape.across;
  buffers.coneUp[sample] = coneSamples * reflection.shape.up;
  buffers.reflectedKeep[sample] = over.keeps;
  buffers.reflectedOver[at] = over.red;
  buffers.reflectedOver[at + 1] = over.green;
  buffers.reflectedOver[at + 2] = over.blue;
  buffers.surfaceKind[sample] = kind;
}

/**
 * Blends the samples of column `sampleCol` strictly between rows `from` and `to`, all off the same wall; none when
 * `from` is -1.
 */
function blendSamplesBetween(buffers: TracedBuffers, sampleCol: number, from: number, to: number): void {
  const { reflectedWidth, reflectedSurface, reflectedOver, reflectedKeep, coneAcross, coneUp, surfaceKind } = buffers;
  const fromSample = from * reflectedWidth + sampleCol;
  const toSample = to * reflectedWidth + sampleCol;
  for (let sampleRow = from + 1; from >= 0 && sampleRow < to; sampleRow++) {
    const share = (sampleRow - from) / (to - from);
    const sample = sampleRow * reflectedWidth + sampleCol;
    for (let channel = 0; channel < 3; channel++) {
      const fromAt = fromSample * 3 + channel;
      const toAt = toSample * 3 + channel;
      reflectedSurface[sample * 3 + channel] = mix(reflectedSurface[fromAt], reflectedSurface[toAt], share);
      reflectedOver[sample * 3 + channel] = mix(reflectedOver[fromAt], reflectedOver[toAt], share);
    }
    reflectedKeep[sample] = mix(reflectedKeep[fromSample], reflectedKeep[toSample], share);
    coneAcross[sample] = mix(coneAcross[fromSample], coneAcross[toSample], share);
    coneUp[sample] = mix(coneUp[fromSample], coneUp[toSample], share);
    surfaceKind[sample] = surfaceKind[toSample] ?? NO_SURFACE;
  }
}

/** A height up a wall (0 floor .. 1 ceiling), or a share, held to 0..1. */
function clampToUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** `from` to `to` by `share`; typed-array reads come in as possibly undefined. */
function mix(from: number | undefined, to: number | undefined, share: number): number {
  const start = from ?? 0;
  return start + ((to ?? 0) - start) * share;
}
