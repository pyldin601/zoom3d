// Server-side plausibility check for client-reported positions.
import { MOVE_SPEED } from '../geometry/movement';
import { type GameMap, isWallAt } from '../map/map';

const SPEED_TOLERANCE = 1.5;
const SLACK_TILES = 0.5;

export function isPlausibleMove(
  map: GameMap,
  from: { x: number; y: number },
  to: { x: number; y: number },
  elapsedMs: number
): boolean {
  if (isWallAt(map, to.x, to.y)) {
    return false;
  }
  const limit = MOVE_SPEED * (Math.max(elapsedMs, 0) / 1000) * SPEED_TOLERANCE + SLACK_TILES;
  return Math.hypot(to.x - from.x, to.y - from.y) <= limit;
}
