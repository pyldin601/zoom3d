// The robot vacuum (robot vacuum spec §3): cleans the map patch by patch at a real robot's pace, then searches for its
// dock forever. Pure: the lobby steps it at 10 Hz and relays its pose.
import { isWallAt, moveWithCollision, type ObjectEvent, type ObjectInfo } from '@zoom3d/shared';
import { mapFingerprint, type Point, VACUUM_RADIUS, type VacuumNav } from './vacuum-nav';

/** Tiles per second: a real robot's 0.3 m/s at this game's scale (walking, 3 tiles/s, is about 1.4 m/s). */
export const VACUUM_SPEED = 0.6;
/** Radians per second, turning in place. */
export const VACUUM_TURN_SPEED = Math.PI / 2;
/** The slow circle it turns while searching for its dock (8 s). */
export const SCAN_TURN_SPEED = Math.PI / 4;
/** Seconds it waits after a search circle before trying elsewhere. */
export const LOST_WAIT_S = 2;
/** A search leg heads further than this many tiles (by path). */
export const SEARCH_MIN_TILES = 10;
/** Seconds of being stuck on one waypoint before giving it up, on top of the time it should take. */
const GIVE_UP_S = 10;
/** It drives once it faces its waypoint within this many radians. */
const AIM = 0.02;
/** A waypoint is reached within this many tiles. */
const ARRIVE = 0.05;
const TWO_PI = Math.PI * 2;

export type VacuumPhase = 'cleaning' | 'searching';

export interface Vacuum {
  id: string;
  x: number;
  y: number;
  angle: number;
  seq: number;
  phase: VacuumPhase;
  /** Patch indices already cleaned. */
  clean: Set<number>;
  /** Waypoints given up on since spawn (for tests and debugging). */
  skipped: number;
  /** The patch being cleaned, while cleaning. */
  patch: number | null;
  /** Where it is going next, nearest first. */
  waypoints: Point[];
  /** Sim time past which the current waypoint is given up. */
  deadline: number;
  /** Seconds simulated since spawn or restore. */
  time: number;
  /** `move` drives the waypoints; `scan` turns the search circle; `pause` waits. */
  mode: 'move' | 'scan' | 'pause';
  /** Radians of circle left in `scan`, seconds left in `pause`. */
  left: number;
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

const wrap = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
/** Shortest signed turn from a to b. */
const turnTo = (a: number, b: number) => {
  const d = wrap(b - a);
  return d > Math.PI ? d - TWO_PI : d;
};

function fresh(id: string, x: number, y: number, angle: number, phase: VacuumPhase, clean: Set<number>): Vacuum {
  return {
    id,
    x,
    y,
    angle: wrap(angle),
    seq: 0,
    phase,
    clean,
    skipped: 0,
    patch: null,
    waypoints: [],
    deadline: 0,
    time: 0,
    mode: 'move',
    left: 0,
  };
}

export function createVacuum(
  nav: VacuumNav,
  rng: () => number,
  id: string,
  opts: { nearlyDone?: boolean } = {}
): Vacuum {
  const tile = nav.floor[Math.floor(rng() * nav.floor.length)] as Point;
  const clean = new Set<number>();
  if (opts.nearlyDone) {
    const own = nav.patchOf(tile.x, tile.y);
    for (const p of nav.dirtyAtStart) {
      if (p !== own) {
        clean.add(p);
      }
    }
  }
  return fresh(id, tile.x + 0.5, tile.y + 0.5, rng() * TWO_PI, 'cleaning', clean);
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
  const clean = new Set(save.clean.filter((p) => known.has(p)));
  return fresh(save.id, save.x, save.y, save.angle, save.phase, clean);
}

export function vacuumInfo(v: Vacuum): ObjectInfo {
  return { id: v.id, kind: 'vacuum', x: v.x, y: v.y, angle: v.angle };
}

/** Gives the current waypoint the time it should take to reach, plus GIVE_UP_S. */
function startWaypoint(v: Vacuum): void {
  const wp = v.waypoints[0];
  if (wp) {
    const distance = Math.hypot(wp.x - v.x, wp.y - v.y);
    v.deadline = v.time + GIVE_UP_S + distance / VACUUM_SPEED + Math.PI / VACUUM_TURN_SPEED;
  }
}

/** The waypoints ran out: a cleaned patch, or the end of a search leg. */
function finishLeg(v: Vacuum): void {
  if (v.phase === 'cleaning') {
    if (v.patch !== null) {
      v.clean.add(v.patch);
      v.patch = null;
    }
  } else {
    v.mode = 'scan';
    v.left = TWO_PI;
  }
}

/** Picks the next patch to clean, or (once all are clean) the next place to look for the dock. */
function plan(nav: VacuumNav, v: Vacuum, rng: () => number): void {
  const here = { x: v.x, y: v.y };
  const dist = nav.distances(here);
  const { width } = nav.map;
  if (v.phase === 'cleaning') {
    let best: Point | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const t of nav.floor) {
      const d = dist[t.y * width + t.x] as number;
      if (d >= 0 && d < bestDist && !v.clean.has(nav.patchOf(t.x, t.y))) {
        best = t;
        bestDist = d;
      }
    }
    if (best) {
      const travel = nav.path(here, best);
      v.patch = nav.patchOf(best.x, best.y);
      v.waypoints = [...travel, ...nav.route(v.patch, travel.at(-1) ?? here)];
      startWaypoint(v);
      if (v.waypoints.length === 0) {
        finishLeg(v);
      }
      return;
    }
    v.phase = 'searching';
  }
  const far = nav.floor.filter((t) => (dist[t.y * width + t.x] as number) > SEARCH_MIN_TILES);
  let target = far[Math.floor(rng() * far.length)];
  if (!target) {
    for (const t of nav.floor) {
      if (!target || (dist[t.y * width + t.x] as number) > (dist[target.y * width + target.x] as number)) {
        target = t;
      }
    }
  }
  v.waypoints = target ? nav.path(here, target) : [];
  startWaypoint(v);
  if (v.waypoints.length === 0) {
    finishLeg(v);
  }
}

/** Drops the current waypoint (reached or given up) and starts the next, or finishes the leg. */
function nextWaypoint(v: Vacuum): void {
  v.waypoints.shift();
  if (v.waypoints.length > 0) {
    startWaypoint(v);
  } else {
    finishLeg(v);
  }
}

/** Advances by dt seconds. `people` are connected persons' positions. Returns the event of this step, if any. */
export function stepVacuum(
  nav: VacuumNav,
  v: Vacuum,
  dt: number,
  rng: () => number,
  _people: readonly Point[]
): ObjectEvent | null {
  v.time += dt;
  if (v.mode === 'pause') {
    v.left -= dt;
    if (v.left <= 0) {
      v.mode = 'move';
    }
    return null;
  }
  if (v.mode === 'scan') {
    const turn = Math.min(v.left, SCAN_TURN_SPEED * dt);
    v.angle = wrap(v.angle + turn);
    v.left -= turn;
    if (v.left <= 1e-9) {
      v.mode = 'pause';
      v.left = LOST_WAIT_S;
      return 'lost';
    }
    return null;
  }

  // Reaching a waypoint costs no time of its own: carry on toward the next in the same step.
  let wp = v.waypoints[0];
  while (wp && Math.hypot(wp.x - v.x, wp.y - v.y) <= ARRIVE) {
    nextWaypoint(v);
    if (v.mode !== 'move') {
      return null;
    }
    wp = v.waypoints[0];
  }
  if (!wp) {
    plan(nav, v, rng);
    return null;
  }
  if (v.time > v.deadline) {
    v.skipped++;
    nextWaypoint(v);
    return null;
  }
  const dx = wp.x - v.x;
  const dy = wp.y - v.y;
  const distance = Math.hypot(dx, dy);
  const target = Math.atan2(dy, dx);
  const error = turnTo(v.angle, target);
  if (Math.abs(error) > AIM) {
    // Turn in place, lining up exactly when this step's turn reaches the waypoint's bearing.
    const budget = VACUUM_TURN_SPEED * dt;
    v.angle = Math.abs(error) <= budget ? wrap(target) : wrap(v.angle + Math.sign(error) * budget);
    return null;
  }
  const step = Math.min(VACUUM_SPEED * dt, distance);
  const to = moveWithCollision(nav.map, v.x, v.y, Math.cos(v.angle) * step, Math.sin(v.angle) * step, VACUUM_RADIUS);
  v.x = to.x;
  v.y = to.y;
  return null;
}
