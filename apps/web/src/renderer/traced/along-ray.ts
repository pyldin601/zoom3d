// Round things a reflection's cone can meet along a 2D ray (spec docs/superpowers/specs/2026-10-17-ray-traced-renderer-
// design.md §3.3): the lamps near the eye, listed once per frame, then per ray the few that pass close enough to show,
// nearest first. Allocation-free once sized: the lists grow only when a room has more things than any before it.
import { LAMP_RADIUS, type TracedWorld } from './world';

/** Things further than this from the eye (tiles) are left out of the frame's reflections. */
const REACH_TILES = 12;
/** The most things one ray keeps: the nearest along it. */
export const MOST_ALONG_RAY = 12;
/** A cone's blob is gone this many spreads to its side. */
const SPREADS_TO_EDGE = 3;
/** However wide a cone, a thing further than this past its radius to the side of a ray (tiles) never shows in it. */
const MOST_MARGIN_TILES = 2;
/** Nearer than this along a ray (in its units), a thing is where the ray leaves its surface, not ahead of it. */
const NEAREST_ALONG = 0.05;

/** The round things near the eye this frame: lamps' discs (centre and radius, tiles), `count` of them. */
export interface NearbyThings {
  count: number;
  x: Float64Array;
  y: Float64Array;
  radius: Float64Array;
}

/**
 * The things one ray passes close to, `count` of them, nearest first: `s` along it (in units of its direction),
 * `side` how far to its side (tiles, positive to its right on the y-down map) and `thing`, an index into NearbyThings.
 */
export interface ThingsAlongRay {
  count: number;
  s: Float64Array;
  side: Float64Array;
  thing: Int16Array;
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
  };
}

/** Lists into `out` the lamps within REACH_TILES of the eye at (eyeX, eyeY). */
export function listNearbyThings(world: TracedWorld, eyeX: number, eyeY: number, out: NearbyThings): void {
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
 * The things the 2D ray from (x, y) along (dx, dy) passes close to before `maxS` (in units of the ray), into `out`:
 * within a thing's radius of the ray, plus three of the cone's spreads at that distance (`spreadPerS` tiles per unit
 * of s), but never more than MOST_MARGIN_TILES past it. Per reflection column, so it reads typed arrays by index.
 */
export function findThingsAlongRay(
  things: NearbyThings,
  x: number,
  y: number,
  dx: number,
  dy: number,
  maxS: number,
  spreadPerS: number,
  out: ThingsAlongRay
): void {
  const runSquared = dx * dx + dy * dy;
  const run = Math.sqrt(runSquared);
  out.count = 0;
  for (let thing = 0; thing < things.count; thing++) {
    const offsetX = (things.x[thing] ?? 0) - x;
    const offsetY = (things.y[thing] ?? 0) - y;
    const s = (offsetX * dx + offsetY * dy) / runSquared;
    if (s <= NEAREST_ALONG || s >= maxS) {
      continue;
    }
    const side = (dx * offsetY - dy * offsetX) / run;
    const reach = (things.radius[thing] ?? 0) + Math.min(MOST_MARGIN_TILES, SPREADS_TO_EDGE * spreadPerS * s);
    if (side >= reach || side <= -reach) {
      continue;
    }
    keepNearest(out, s, side, thing);
  }
}

/** Inserts a thing into a list kept in order of s; once the list is full, a thing further than all of it is dropped. */
function keepNearest(out: ThingsAlongRay, s: number, side: number, thing: number): void {
  if (out.count === MOST_ALONG_RAY && s >= (out.s[MOST_ALONG_RAY - 1] ?? 0)) {
    return;
  }
  let at = out.count < MOST_ALONG_RAY ? out.count++ : MOST_ALONG_RAY - 1;
  for (; at > 0 && (out.s[at - 1] ?? 0) > s; at--) {
    out.s[at] = out.s[at - 1] ?? 0;
    out.side[at] = out.side[at - 1] ?? 0;
    out.thing[at] = out.thing[at - 1] ?? 0;
  }
  out.s[at] = s;
  out.side[at] = side;
  out.thing[at] = thing;
}
