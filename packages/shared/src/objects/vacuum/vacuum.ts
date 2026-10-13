// The robot vacuum (robot vacuum spec §3): cleans the map patch by patch at a real robot's pace, then searches for its
// dock forever. Pure: the lobby steps it at 10 Hz and relays its pose.
//
// Two pieces of state drive it:
// - `phase` is its long-term goal: `cleaning` patches, then `searching` for the dock (it never finds it).
// - `activity` is what it does this step: `move` along its waypoints, `scan` the slow search circle, or `pause`.
import { moveWithCollision, PLAYER_RADIUS } from '../../geometry/movement';
import { isWallAt } from '../../map/map';
import type { ObjectEvent, ObjectInfo } from '../../protocol/protocol';
import { pick } from '../../random';
import { mapFingerprint, type Point, VACUUM_RADIUS, type VacuumNav } from './nav';

/** Tiles per second: a real robot's 0.3 m/s at this game's scale (walking, 3 tiles/s, is about 1.4 m/s). */
export const VACUUM_SPEED = 0.6;
/** Radians per second, turning in place. */
export const VACUUM_TURN_SPEED = Math.PI / 2;
/** Radians per second of the slow circle it turns while searching for its dock (8 s a circle). */
const SCAN_TURN_SPEED = Math.PI / 4;
/** Seconds it waits after a search circle before trying elsewhere. */
const LOST_WAIT_S = 2;
/** A search leg heads further than this many tiles (by path). */
const SEARCH_MIN_TILES = 10;
/** Seconds it stands still after bumping into someone. */
const BUMP_PAUSE_S = 0.3;
/** Seconds it waits, quietly, when someone blocks it with no room to go round (a doorway, a corridor). */
const BLOCKED_WAIT_S = 2;
/** How far it steps aside from someone it bumped, in tiles: past touching distance, so the way round is clear. */
const SIDESTEP_DISTANCE = 0.7;
/** How far it drives on beside them, in tiles, before heading back to its waypoint. */
const PASS_DISTANCE = 1.2;
/** It bumps a person whose centre is this close (tiles), in front of it. */
const BUMP_DISTANCE = VACUUM_RADIUS + PLAYER_RADIUS;
/** Someone is in front when the cosine of their angle off its heading is above this (within about 78°). */
const FRONT_MIN_COS = 0.2;
/** It only thuds again once it has moved this far (tiles) since its last bump. */
const REBUMP_DISTANCE = 0.1;
/** Seconds of being stuck on one waypoint before giving it up, on top of the time it should take. */
const GIVE_UP_S = 10;
/** It drives once it faces its waypoint within this many radians. */
const AIM_TOLERANCE = 0.02;
/** A waypoint is reached within this many tiles. */
const ARRIVE_DISTANCE = 0.05;
/** Radians of search circle left that count as none (floating-point rounding). */
const SCAN_EPSILON = 1e-9;
const TWO_PI = Math.PI * 2;

export type VacuumPhase = 'cleaning' | 'searching';

/** What it is doing this step. */
export type VacuumActivity =
  | { kind: 'move' }
  | { kind: 'scan'; radiansLeft: number }
  | { kind: 'pause'; secondsLeft: number };

/** A waypoint; a detour (round someone it bumped) keeps the give-up deadline of the waypoint it detours to. */
interface Waypoint extends Point {
  detour?: true;
}

export interface Vacuum {
  id: string;
  x: number;
  y: number;
  angle: number;
  seq: number;
  phase: VacuumPhase;
  activity: VacuumActivity;
  /** Patch indices already cleaned. */
  clean: Set<number>;
  /** The patch being cleaned, while cleaning. */
  patch: number | null;
  /** Where it is going next, nearest first. */
  waypoints: Waypoint[];
  /** Sim time past which the current waypoint is given up. */
  deadline: number;
  /** Seconds simulated since spawn or restore. */
  time: number;
  /** Where it last bumped someone: it stays quiet bumping again without having moved. */
  lastBump: Point | null;
  /** Waypoints given up on since spawn (for tests and debugging). */
  waypointsSkipped: number;
}

/** The robot as written to the restart snapshot. */
export interface VacuumSave {
  id: string;
  x: number;
  y: number;
  angle: number;
  phase: VacuumPhase;
  clean: number[];
  /** mapFingerprint of the map it cleaned. */
  map: string;
}

/** The angle in [0, 2π). */
const normalizeAngle = (angle: number) => ((angle % TWO_PI) + TWO_PI) % TWO_PI;

/** The shortest signed turn from heading `from` to heading `to`, in (-π, π]. */
const shortestTurn = (from: number, to: number) => {
  const turn = normalizeAngle(to - from);
  return turn > Math.PI ? turn - TWO_PI : turn;
};

/** A robot standing at (x, y) with no plan yet: its first step plans a leg. */
function initialState(id: string, x: number, y: number, angle: number, phase: VacuumPhase, clean: Set<number>): Vacuum {
  return {
    id,
    x,
    y,
    angle: normalizeAngle(angle),
    seq: 0,
    phase,
    activity: { kind: 'move' },
    clean,
    patch: null,
    waypoints: [],
    deadline: 0,
    time: 0,
    lastBump: null,
    waypointsSkipped: 0,
  };
}

export function createVacuum(
  nav: VacuumNav,
  rng: () => number,
  id: string,
  opts: { nearlyDone?: boolean } = {}
): Vacuum {
  const tile = pick(rng, nav.floor);
  if (!tile) {
    throw new Error('the map has no floor for the robot vacuum');
  }
  const clean = new Set<number>();
  if (opts.nearlyDone) {
    const own = nav.patchOf(tile.x, tile.y);
    for (const patch of nav.dirtyAtStart) {
      if (patch !== own) {
        clean.add(patch);
      }
    }
  }
  return initialState(id, tile.x + 0.5, tile.y + 0.5, rng() * TWO_PI, 'cleaning', clean);
}

/** A robot parked at a chosen pose with nothing cleaned yet (the landing page's, which starts out of view). */
export function parkVacuum(id: string, x: number, y: number, angle: number): Vacuum {
  return initialState(id, x, y, angle, 'cleaning', new Set());
}

export function saveVacuum(nav: VacuumNav, v: Vacuum): VacuumSave {
  return {
    id: v.id,
    x: v.x,
    y: v.y,
    angle: v.angle,
    phase: v.phase,
    clean: [...v.clean],
    map: mapFingerprint(nav.map),
  };
}

/** The saved robot, re-planning from scratch (its patch in progress is redone); null if it belongs to another map. */
export function restoreVacuum(nav: VacuumNav, save: VacuumSave): Vacuum | null {
  if (save.map !== mapFingerprint(nav.map) || isWallAt(nav.map, save.x, save.y)) {
    return null;
  }
  const known = new Set(nav.dirtyAtStart);
  const clean = new Set(save.clean.filter((patch) => known.has(patch)));
  return initialState(save.id, save.x, save.y, save.angle, save.phase, clean);
}

export function vacuumInfo(v: Vacuum): ObjectInfo {
  return { id: v.id, kind: 'vacuum', x: v.x, y: v.y, angle: v.angle };
}

/** Advances by dt seconds. `people` are connected persons' positions. Returns the event of this step, if any. */
export function stepVacuum(
  nav: VacuumNav,
  v: Vacuum,
  dt: number,
  rng: () => number,
  people: readonly Point[]
): ObjectEvent | null {
  v.time += dt;
  const activity = v.activity;
  switch (activity.kind) {
    case 'pause':
      return stepPause(v, activity, dt);
    case 'scan':
      return stepScan(v, activity, dt);
    case 'move':
      return stepMove(nav, v, dt, rng, people);
  }
}

function stepPause(v: Vacuum, pause: { secondsLeft: number }, dt: number): null {
  pause.secondsLeft -= dt;
  if (pause.secondsLeft <= 0) {
    v.activity = { kind: 'move' };
  }
  return null;
}

/** Turns the slow search circle; a full circle says `lost` and waits before the next search leg. */
function stepScan(v: Vacuum, scan: { radiansLeft: number }, dt: number): ObjectEvent | null {
  const turn = Math.min(scan.radiansLeft, SCAN_TURN_SPEED * dt);
  v.angle = normalizeAngle(v.angle + turn);
  scan.radiansLeft -= turn;
  if (scan.radiansLeft > SCAN_EPSILON) {
    return null;
  }
  v.activity = { kind: 'pause', secondsLeft: LOST_WAIT_S };
  return 'lost';
}

/** Heads for the current waypoint: plans a leg when there is none, turns in place to face it, then drives. */
function stepMove(
  nav: VacuumNav,
  v: Vacuum,
  dt: number,
  rng: () => number,
  people: readonly Point[]
): ObjectEvent | null {
  // Reaching a waypoint costs no time of its own: carry on toward the next in the same step.
  let waypoint = v.waypoints.at(0);
  while (waypoint && Math.hypot(waypoint.x - v.x, waypoint.y - v.y) <= ARRIVE_DISTANCE) {
    nextWaypoint(v);
    if (v.activity.kind !== 'move') {
      return null;
    }
    waypoint = v.waypoints.at(0);
  }
  if (!waypoint) {
    planLeg(nav, v, rng);
    return null;
  }
  if (v.time > v.deadline) {
    skipWaypoint(v);
    return null;
  }

  const bearing = Math.atan2(waypoint.y - v.y, waypoint.x - v.x);
  const error = shortestTurn(v.angle, bearing);
  if (Math.abs(error) > AIM_TOLERANCE) {
    turnToward(v, bearing, error, dt);
    return null;
  }

  const person = personInFront(v, people);
  if (person) {
    return bump(nav, v, person);
  }
  const step = Math.min(VACUUM_SPEED * dt, Math.hypot(waypoint.x - v.x, waypoint.y - v.y));
  const to = moveWithCollision(nav.map, v.x, v.y, Math.cos(v.angle) * step, Math.sin(v.angle) * step, VACUUM_RADIUS);
  v.x = to.x;
  v.y = to.y;
  return null;
}

/** Turns in place by at most this step's budget, lining up exactly once the turn reaches `bearing`. */
function turnToward(v: Vacuum, bearing: number, error: number, dt: number): void {
  const budget = VACUUM_TURN_SPEED * dt;
  v.angle = Math.abs(error) <= budget ? normalizeAngle(bearing) : normalizeAngle(v.angle + Math.sign(error) * budget);
}

// Planning: a leg is the list of waypoints to one patch and across it, or to one place to search for the dock.

/** Picks the next leg: the nearest dirty patch while cleaning, else a far-off place to look for the dock. */
function planLeg(nav: VacuumNav, v: Vacuum, rng: () => number): void {
  const here = { x: v.x, y: v.y };
  const distanceTo = nav.distances(here);
  if (v.phase === 'cleaning') {
    if (planCleaning(nav, v, here, distanceTo)) {
      return;
    }
    // Every patch is clean.
    v.phase = 'searching';
  }
  planSearch(nav, v, rng, here, distanceTo);
}

/** Heads for the nearest dirty patch and covers it; false when every patch is clean. */
function planCleaning(nav: VacuumNav, v: Vacuum, here: Point, distanceTo: (tile: Point) => number): boolean {
  const target = nearestTile(nav.floor, distanceTo, (tile) => !v.clean.has(nav.patchOf(tile.x, tile.y)));
  if (!target) {
    return false;
  }
  const travel = nav.path(here, target);
  v.patch = nav.patchOf(target.x, target.y);
  startLeg(v, [...travel, ...nav.route(v.patch, travel.at(-1) ?? here)]);
  return true;
}

/** Heads for a random tile more than SEARCH_MIN_TILES away by path, or the farthest tile if none is that far. */
function planSearch(
  nav: VacuumNav,
  v: Vacuum,
  rng: () => number,
  here: Point,
  distanceTo: (tile: Point) => number
): void {
  const far = nav.floor.filter((tile) => distanceTo(tile) > SEARCH_MIN_TILES);
  const target = pick(rng, far) ?? farthestTile(nav.floor, distanceTo);
  startLeg(v, target ? nav.path(here, target) : []);
}

/** The reachable tile nearest by path that passes `accept`; the first one found on a tie. */
function nearestTile(
  tiles: readonly Point[],
  distanceTo: (tile: Point) => number,
  accept: (tile: Point) => boolean
): Point | null {
  let best: Point | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tile of tiles) {
    const distance = distanceTo(tile);
    if (distance >= 0 && distance < bestDistance && accept(tile)) {
      best = tile;
      bestDistance = distance;
    }
  }
  return best;
}

/** The tile farthest by path; the first one found on a tie. */
function farthestTile(tiles: readonly Point[], distanceTo: (tile: Point) => number): Point | null {
  let best: Point | null = null;
  for (const tile of tiles) {
    if (!best || distanceTo(tile) > distanceTo(best)) {
      best = tile;
    }
  }
  return best;
}

/** Replaces the waypoints with a new leg; an empty leg finishes at once. */
function startLeg(v: Vacuum, waypoints: Waypoint[]): void {
  v.waypoints = waypoints;
  startWaypoint(v);
  if (waypoints.length === 0) {
    finishLeg(v);
  }
}

/** The waypoints ran out: a cleaned patch, or the end of a search leg, where it turns a search circle. */
function finishLeg(v: Vacuum): void {
  if (v.phase === 'searching') {
    v.activity = { kind: 'scan', radiansLeft: TWO_PI };
  } else if (v.patch !== null) {
    v.clean.add(v.patch);
    v.patch = null;
  }
}

/** Gives the current waypoint the time it should take to reach, plus GIVE_UP_S. */
function startWaypoint(v: Vacuum): void {
  const waypoint = v.waypoints.at(0);
  if (waypoint) {
    const distance = Math.hypot(waypoint.x - v.x, waypoint.y - v.y);
    v.deadline = v.time + GIVE_UP_S + distance / VACUUM_SPEED + Math.PI / VACUUM_TURN_SPEED;
  }
}

/** Drops the current waypoint (reached or given up) and starts the next, or finishes the leg. */
function nextWaypoint(v: Vacuum): void {
  const done = v.waypoints.shift();
  if (v.waypoints.length === 0) {
    finishLeg(v);
  } else if (!done?.detour) {
    startWaypoint(v);
  }
}

/** Gives up the current waypoint, with any detour on the way to it. */
function skipWaypoint(v: Vacuum): void {
  while (v.waypoints.at(0)?.detour) {
    v.waypoints.shift();
  }
  v.waypointsSkipped++;
  nextWaypoint(v);
}

// Bumping into people.

/** The first person it would drive into: within touching distance and in front. */
function personInFront(v: Vacuum, people: readonly Point[]): Point | null {
  const fx = Math.cos(v.angle);
  const fy = Math.sin(v.angle);
  for (const person of people) {
    const dx = person.x - v.x;
    const dy = person.y - v.y;
    const d2 = dx * dx + dy * dy;
    // dx·f / |d| is the cosine of their angle off its heading: someone exactly beside it is not in its way.
    if (d2 < BUMP_DISTANCE * BUMP_DISTANCE && dx * fx + dy * fy > FRONT_MIN_COS * Math.sqrt(d2)) {
      return person;
    }
  }
  return null;
}

/** Goes round the person it bumped; returns `bump` unless it hasn't moved since its last bump. */
function bump(nav: VacuumNav, v: Vacuum, person: Point): ObjectEvent | null {
  goRound(nav, v, person);
  // Pressed up against someone it can't get round, it doesn't keep thudding into them.
  const last = v.lastBump;
  const moved = !last || Math.hypot(v.x - last.x, v.y - last.y) > REBUMP_DISTANCE;
  v.lastBump = { x: v.x, y: v.y };
  return moved ? 'bump' : null;
}

/**
 * Stops, then steps aside (away from the person, unless a wall is there) and drives on past them. With no room on
 * either side it just waits; the waypoint deadline gives up a way that stays blocked.
 */
function goRound(nav: VacuumNav, v: Vacuum, person: Point): void {
  const fx = Math.cos(v.angle);
  const fy = Math.sin(v.angle);
  // On the y-down map (-fy, fx) is the robot's right: side +1 steps right, -1 left. The cross product's sign tells
  // which side the person is on.
  const personOnRight = fx * (person.y - v.y) - fy * (person.x - v.x) > 0;
  const awayFromPerson = personOnRight ? -1 : 1;
  for (const side of [awayFromPerson, -awayFromPerson]) {
    const aside = {
      x: v.x - fy * SIDESTEP_DISTANCE * side,
      y: v.y + fx * SIDESTEP_DISTANCE * side,
      detour: true as const,
    };
    if (!bodyFits(nav, aside.x, aside.y)) {
      continue;
    }
    const past = { x: aside.x + fx * PASS_DISTANCE, y: aside.y + fy * PASS_DISTANCE, detour: true as const };
    v.waypoints.unshift(...(bodyFits(nav, past.x, past.y) ? [aside, past] : [aside]));
    v.activity = { kind: 'pause', secondsLeft: BUMP_PAUSE_S };
    return;
  }
  v.activity = { kind: 'pause', secondsLeft: BLOCKED_WAIT_S };
}

/** Whether the robot's square body would fit at (x, y). */
function bodyFits(nav: VacuumNav, x: number, y: number): boolean {
  return (
    !isWallAt(nav.map, x - VACUUM_RADIUS, y - VACUUM_RADIUS) &&
    !isWallAt(nav.map, x + VACUUM_RADIUS, y - VACUUM_RADIUS) &&
    !isWallAt(nav.map, x - VACUUM_RADIUS, y + VACUUM_RADIUS) &&
    !isWallAt(nav.map, x + VACUUM_RADIUS, y + VACUUM_RADIUS)
  );
}
