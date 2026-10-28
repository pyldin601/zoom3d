// Server-side plausibility check for client-reported positions.
import { MOVE_SPEED } from '../geometry/movement';
import { type GameMap, isWallAt } from '../map/map';
import { type Apparent, apparentPosition } from '../portals/apparent';
import type { Portals } from '../portals/wiring';

const SPEED_TOLERANCE = 1.5;
const SLACK_TILES = 0.5;

const apparentTarget: Apparent = { x: 0, y: 0, sees: false, through: 0 };

/** With portals, a step through a doorway is short as seen from `from`: the distance is to where `to` appears. */
export function isPlausibleMove(
  map: GameMap,
  from: { x: number; y: number },
  to: { x: number; y: number },
  elapsedMs: number,
  portals: Portals | null = null
): boolean {
  if (isWallAt(map, to.x, to.y)) {
    return false;
  }
  const limit = MOVE_SPEED * (Math.max(elapsedMs, 0) / 1000) * SPEED_TOLERANCE + SLACK_TILES;
  if (portals === null) {
    return Math.hypot(to.x - from.x, to.y - from.y) <= limit;
  }
  const apparent = apparentPosition(map, portals, from, to, apparentTarget, 1);
  return Math.hypot(apparent.x - from.x, apparent.y - from.y) <= limit;
}
