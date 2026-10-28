// Apparent position (portal spec 2.6): where a target appears to a listener, straight or through up to two portals.
// Pure; the scratch is module-level, so a call allocates nothing.

import { hasLineOfSight } from '../geometry/los';
import type { GameMap } from '../map/map';
import { NEAR_TILES } from '../protocol/protocol';
import { crossedPortal, fractionAcrossPlane } from './crossing';
import { applyPoint } from './transform';
import type { Portal, Portals } from './wiring';

/** As hasLineOfSight, but false when the straight segment crosses a plane front→back. */
export function hasPortalLineOfSight(
  map: GameMap,
  p: Portals | null,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  return hasLineOfSight(map, ax, ay, bx, by) && (p === null || crossedPortal(p, ax, ay, bx, by, crossing) < 0);
}

export interface Apparent {
  x: number;
  y: number;
  sees: boolean;
  /** How many portals the target is seen through. */
  through: 0 | 1 | 2;
}

type Point = { x: number; y: number };

const NEAR_TILES_SQUARED = NEAR_TILES * NEAR_TILES;

const crossing = { t: 0 };
const best = { x: 0, y: 0, sees: false, through: 0 as Apparent['through'], distanceSquared: 0 };
const virtualEye: Point = { x: 0, y: 0 };
const deeperImage: Point = { x: 0, y: 0 };
const image: Point = { x: 0, y: 0 };
const onPlane: Point = { x: 0, y: 0 };
const hop: Point = { x: 0, y: 0 };
const aim: Point = { x: 0, y: 0 };
const chain = { sees: false };

/**
 * Writes into `out` (which may be `to`). Candidates are the real position and every image whose chain passes the
 * doorways' openings in order; a seen one beats an unseen one, then the nearer wins.
 */
export function apparentPosition(
  map: GameMap,
  p: Portals | null,
  from: Point,
  to: Point,
  out: Apparent,
  maxDepth: 1 | 2 = 2
): Apparent {
  const fromX = from.x;
  const fromY = from.y;
  const toX = to.x;
  const toY = to.y;
  best.x = toX;
  best.y = toY;
  best.sees = hasPortalLineOfSight(map, p, fromX, fromY, toX, toY);
  best.through = 0;
  best.distanceSquared = distanceSquared(fromX, fromY, toX, toY);
  if (p !== null) {
    considerImages(map, p, fromX, fromY, toX, toY, maxDepth);
  }
  out.x = best.x;
  out.y = best.y;
  out.sees = best.sees;
  out.through = best.through;
  return out;
}

function considerImages(
  map: GameMap,
  p: Portals,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  maxDepth: 1 | 2
): void {
  for (let first = 0; first < p.list.length; first++) {
    const firstPortal = p.list.at(first);
    if (firstPortal === undefined || !isWorthTrying(firstPortal, fromX, fromY)) {
      continue;
    }
    applyPoint(firstPortal.fromDest, toX, toY, image);
    considerImage(map, p, fromX, fromY, toX, toY, first, -1);
    if (maxDepth === 1) {
      continue;
    }
    // The second doorway is tried as the first one is, from the eye carried through the first portal.
    applyPoint(firstPortal.toDest, fromX, fromY, virtualEye);
    for (let second = 0; second < p.list.length; second++) {
      const secondPortal = p.list.at(second);
      if (secondPortal === undefined || !isWorthTrying(secondPortal, virtualEye.x, virtualEye.y)) {
        continue;
      }
      applyPoint(secondPortal.fromDest, toX, toY, deeperImage);
      applyPoint(firstPortal.fromDest, deeperImage.x, deeperImage.y, image);
      considerImage(map, p, fromX, fromY, toX, toY, first, second);
    }
  }
}

/** Only doorways whose front faces the eye and whose centre is in the near range (spec 2.6, for the tick's cost). */
function isWorthTrying(portal: Portal, eyeX: number, eyeY: number): boolean {
  const facesEye = (eyeX - portal.cx) * portal.nx + (eyeY - portal.cy) * portal.ny < 0;
  return facesEye && distanceSquared(eyeX, eyeY, portal.cx, portal.cy) <= NEAR_TILES_SQUARED;
}

/** Takes `image` as the best when its chain counts and it beats the best: seen over unseen, then nearer. */
function considerImage(
  map: GameMap,
  p: Portals,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  first: number,
  second: number
): void {
  const imageDistanceSquared = distanceSquared(fromX, fromY, image.x, image.y);
  const isNearer = imageDistanceSquared < best.distanceSquared;
  const mightBeatBest = !best.sees || isNearer;
  if (!mightBeatBest || !chainCounts(map, p, fromX, fromY, toX, toY, first, second)) {
    return;
  }
  const beatsBest = chain.sees ? !best.sees || isNearer : !best.sees && isNearer;
  if (!beatsBest) {
    return;
  }
  best.x = image.x;
  best.y = image.y;
  best.sees = chain.sees;
  best.through = second < 0 ? 1 : 2;
  best.distanceSquared = imageDistanceSquared;
}

/**
 * Whether the segment eye→image goes through the opening of `first`, then of `second` (−1: none), in order (spec
 * 2.6). `chain.sees` says whether every leg is also a line of sight.
 */
function chainCounts(
  map: GameMap,
  p: Portals,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  first: number,
  second: number
): boolean {
  chain.sees = true;
  if (!passesThrough(map, p, first, fromX, fromY, image.x, image.y)) {
    return false;
  }
  if (second >= 0 && !passesThrough(map, p, second, hop.x, hop.y, aim.x, aim.y)) {
    return false;
  }
  chain.sees = chain.sees && hasPortalLineOfSight(map, p, hop.x, hop.y, toX, toY);
  return true;
}

/**
 * Whether start→end crosses `index` first, inside its opening. If so, `hop` is the crossing carried to the
 * destination's plane, `aim` is `end` carried likewise, and `chain.sees` is cleared when the leg up to the plane is
 * no line of sight.
 */
function passesThrough(
  map: GameMap,
  p: Portals,
  index: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number
): boolean {
  const portal = p.list.at(index);
  if (portal === undefined || fractionAcrossPlane(portal, startX, startY, endX, endY) < 0) {
    return false;
  }
  if (crossedPortal(p, startX, startY, endX, endY, crossing) !== index) {
    return false;
  }
  pointOnPlane(portal, startX, startY, endX, endY, crossing.t, onPlane);
  chain.sees = chain.sees && hasLineOfSight(map, startX, startY, onPlane.x, onPlane.y);
  applyPoint(portal.toDest, onPlane.x, onPlane.y, hop);
  applyPoint(portal.toDest, endX, endY, aim);
  return true;
}

function pointOnPlane(
  portal: Portal,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  t: number,
  out: Point
): Point {
  out.x = startX + t * (endX - startX);
  out.y = startY + t * (endY - startY);
  // Exactly on the plane, so the carried point lies exactly on the destination's plane and never counts as crossing it.
  if (portal.door.axis === 'ns') {
    out.y = portal.cy;
  } else {
    out.x = portal.cx;
  }
  return out;
}

function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  return (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
}
