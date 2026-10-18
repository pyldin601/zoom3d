// Round things a reflection's cone can meet along a 2D ray (spec docs/superpowers/specs/2026-10-17-ray-traced-renderer-
// design.md §3.3): the lamps (here) and people (people.ts) near the eye, listed once per frame, then per ray the few that
// pass close enough to show, nearest first. Allocation-free once sized: the lists grow only when a room has more things
// than any before it.
import { LAMP_RADIUS, type TracedWorld } from './world';

/** Things further than this from the eye (tiles) are left out of the frame's reflections. */
export const REACH_TILES = 12;
/** The most things one ray keeps: the nearest along it. */
export const MOST_ALONG_RAY = 12;
/** A cone's blob is gone this many spreads to its side. */
const SPREADS_TO_EDGE = 3;
/** However wide a cone, a thing further than this past its radius to the side of a ray (tiles) never shows in it. */
const MOST_MARGIN_TILES = 2;
/** A thing fades out over this many tiles before that margin, so it never drops out of a column all at once. */
const FADE_TILES = 0.5;
/** Nearer than this along a ray (in its units), a thing is where the ray leaves its surface, not ahead of it. */
const NEAREST_ALONG = 0.05;

/** The round things near the eye this frame: lamps' or people's discs (centre and radius, tiles), `count` of them. */
export interface NearbyThings {
  count: number;
  x: Float64Array;
  y: Float64Array;
  radius: Float64Array;
}

/**
 * A 2D ray across the map and the cone round it, as things are found along it: from (x, y) along (dx, dy) to the wall
 * it meets, `wallS` along it (in units of the ray), the cone growing `spreadPerS` tiles to each side per unit.
 */
export interface ConeAcrossMap {
  x: number;
  y: number;
  dx: number;
  dy: number;
  wallS: number;
  spreadPerS: number;
}

/**
 * The things one ray passes close to, `count` of them, nearest first: `s` along it (in units of its direction),
 * `side` how far to its side (tiles, positive to its right on the y-down map) and `thing`, an index into NearbyThings.
 * `shown` (0..1) is how much of it shows: less than 1 in the last FADE_TILES before the margin, or where walls hide it
 * from part of the cone.
 */
export interface ThingsAlongRay {
  count: number;
  s: Float64Array;
  side: Float64Array;
  thing: Int16Array;
  shown: Float64Array;
}

export function createNearbyThings(): NearbyThings {
  return { count: 0, x: new Float64Array(0), y: new Float64Array(0), radius: new Float64Array(0) };
}

export function createThingsAlongRay(): ThingsAlongRay {
  return {
    count: 0,
    s: new Float64Array(MOST_ALONG_RAY),
    side: new Float64Array(MOST_ALONG_RAY),
    thing: new Int16Array(MOST_ALONG_RAY),
    shown: new Float64Array(MOST_ALONG_RAY),
  };
}

/** Lists into `out` the lamps within REACH_TILES of the eye at (eyeX, eyeY). */
export function listNearbyLamps(world: TracedWorld, eyeX: number, eyeY: number, out: NearbyThings): void {
  const lamps = world.lampX.length;
  if (out.x.length < lamps) {
    out.x = new Float64Array(lamps);
    out.y = new Float64Array(lamps);
    out.radius = new Float64Array(lamps);
  }
  let count = 0;
  for (let lamp = 0; lamp < lamps; lamp++) {
    const x = world.lampX[lamp] ?? 0;
    const y = world.lampY[lamp] ?? 0;
    if ((x - eyeX) ** 2 + (y - eyeY) ** 2 > REACH_TILES * REACH_TILES) {
      continue;
    }
    out.x[count] = x;
    out.y[count] = y;
    out.radius[count] = LAMP_RADIUS;
    count++;
  }
  out.count = count;
}

/**
 * The things `cone`'s ray passes close to before its wall, into `out`: within a thing's radius of the ray, plus three of
 * the cone's spreads at that distance, but never more than MOST_MARGIN_TILES past it, fading out over the last
 * FADE_TILES of that. Given `seenPastWalls`, per thing how much of it the cone sees past the walls of the columns it
 * spreads over (occlusion.ts), a thing past the ray's own wall is listed too, and each is shown by that much. Per
 * reflection column, so it reads typed arrays by index.
 */
export function findThingsAlongRay(
  things: NearbyThings,
  cone: ConeAcrossMap,
  out: ThingsAlongRay,
  seenPastWalls?: Float64Array
): void {
  const { x, y, dx, dy, wallS, spreadPerS } = cone;
  const runSquared = dx * dx + dy * dy;
  const run = Math.sqrt(runSquared);
  out.count = 0;
  for (let thing = 0; thing < things.count; thing++) {
    const offsetX = (things.x[thing] ?? 0) - x;
    const offsetY = (things.y[thing] ?? 0) - y;
    const s = (offsetX * dx + offsetY * dy) / runSquared;
    const seen = seenPastWalls === undefined ? (s < wallS ? 1 : 0) : (seenPastWalls[thing] ?? 0);
    if (s <= NEAREST_ALONG || seen === 0) {
      continue;
    }
    const side = (dx * offsetY - dy * offsetX) / run;
    const radius = things.radius[thing] ?? 0;
    const reach = radius + Math.min(MOST_MARGIN_TILES, SPREADS_TO_EDGE * spreadPerS * s);
    if (side >= reach || side <= -reach) {
      continue;
    }
    const toMargin = (radius + MOST_MARGIN_TILES - Math.abs(side)) / FADE_TILES;
    keepNearest(out, s, side, thing, seen * (toMargin >= 1 ? 1 : toMargin * toMargin * (3 - 2 * toMargin)));
  }
}

/** Inserts a thing into a list kept in order of s; once the list is full, a thing further than all of it is dropped. */
function keepNearest(out: ThingsAlongRay, s: number, side: number, thing: number, shown: number): void {
  if (out.count === MOST_ALONG_RAY && s >= (out.s[MOST_ALONG_RAY - 1] ?? 0)) {
    return;
  }
  let at = out.count < MOST_ALONG_RAY ? out.count++ : MOST_ALONG_RAY - 1;
  for (; at > 0 && (out.s[at - 1] ?? 0) > s; at--) {
    out.s[at] = out.s[at - 1] ?? 0;
    out.side[at] = out.side[at - 1] ?? 0;
    out.thing[at] = out.thing[at - 1] ?? 0;
    out.shown[at] = out.shown[at - 1] ?? 0;
  }
  out.s[at] = s;
  out.side[at] = side;
  out.thing[at] = thing;
  out.shown[at] = shown;
}
