// Kick scooters (kick scooter spec): where the rack stands, who can step on, and how parked scooters are saved. A
// ridden scooter is not an object at all: it is its rider's `riding`.

import type { GameMap } from '../../map/map';
import { isWallAt } from '../../map/map';
import { mapFingerprint, type Point } from '../vacuum/nav';

/** Tiles/s riding forward: twice walking. Backward and sideways stay at walking speed. */
export const RIDE_SPEED = 6;
/** How far from a scooter's centre its rider can stand and still step on. */
export const MOUNT_REACH = 1;
export const SCOOTER_COUNT = 6;
/** After stepping off, ride-speed poses still in flight are let through for this long. */
export const RIDE_GRACE_MS = 1000;

export interface ScooterPose {
  id: string;
  x: number;
  y: number;
  angle: number;
}

export interface ScooterSave {
  /** mapFingerprint of the map they were parked on. */
  map: string;
  scooters: ScooterPose[];
}

/**
 * Side by side against the south wall of the hall just south of LEVEL1's spawn room, two tiles apart and centred on
 * the corridor's opening, handlebars to the north (owner, 2026-11-07): facing into the hall, a rider rolls straight off.
 */
const RACK: readonly Point[] = [29.5, 31.5, 33.5, 35.5, 37.5, 39.5].map((x) => ({ x, y: 55.5 }));
const RACK_ANGLE = -Math.PI / 2;

export function rackSpots(map: GameMap): { x: number; y: number; angle: number }[] {
  return RACK.filter((p) => !isWallAt(map, p.x, p.y)).map((p) => ({ x: p.x, y: p.y, angle: RACK_ANGLE }));
}

export function canMount(rider: Point, scooter: Point, slack = 0): boolean {
  return Math.hypot(scooter.x - rider.x, scooter.y - rider.y) <= MOUNT_REACH + slack;
}

export function saveScooters(map: GameMap, scooters: Iterable<ScooterPose>): ScooterSave {
  return { map: mapFingerprint(map), scooters: [...scooters].map(({ id, x, y, angle }) => ({ id, x, y, angle })) };
}

function isPose(v: unknown): v is ScooterPose {
  const p = v as Partial<ScooterPose> | null;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.id === 'string' &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.angle)
  );
}

/** The saved parked scooters; null when the save is malformed, for another map, or has one inside a wall. */
export function restoreScooters(map: GameMap, save: unknown): ScooterPose[] | null {
  const s = save as Partial<ScooterSave> | null;
  if (typeof s !== 'object' || s === null || s.map !== mapFingerprint(map) || !Array.isArray(s.scooters)) {
    return null;
  }
  const scooters: unknown[] = s.scooters;
  if (!scooters.every(isPose) || scooters.some((p) => isWallAt(map, p.x, p.y))) {
    return null;
  }
  return scooters.map(({ id, x, y, angle }) => ({ id, x, y, angle }));
}
