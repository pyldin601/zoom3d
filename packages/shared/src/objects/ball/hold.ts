// Where a dribbled ball is (ball dribble spec §2.2): at the right hand, in front of where the player looks, pulled back
// towards them when a wall or a portal plane is in the way. Pure and shared, so the server and every screen agree.
// Allocates nothing.
import { type GameMap, isWallAt } from '../../map/map';
import { crossedPortal } from '../../portals/crossing';
import type { Portals } from '../../portals/wiring';
import { BALL_RADIUS } from './ball';

export const HOLD_FORWARD_TILES = 0.5;
export const HOLD_SIDE_TILES = 0.2;
/** Halvings of the way back: 1/256 of the reach is far below a pixel. */
const PULL_BACK_STEPS = 8;
const DIAGONAL = Math.SQRT1_2 * BALL_RADIUS;

const crossing = { t: 0 };

function ballClearAt(map: GameMap, x: number, y: number): boolean {
  return (
    !isWallAt(map, x + BALL_RADIUS, y) &&
    !isWallAt(map, x - BALL_RADIUS, y) &&
    !isWallAt(map, x, y + BALL_RADIUS) &&
    !isWallAt(map, x, y - BALL_RADIUS) &&
    !isWallAt(map, x + DIAGONAL, y + DIAGONAL) &&
    !isWallAt(map, x + DIAGONAL, y - DIAGONAL) &&
    !isWallAt(map, x - DIAGONAL, y + DIAGONAL) &&
    !isWallAt(map, x - DIAGONAL, y - DIAGONAL)
  );
}

function reachableAt(map: GameMap, portals: Portals | null, fromX: number, fromY: number, x: number, y: number) {
  return ballClearAt(map, x, y) && (portals === null || crossedPortal(portals, fromX, fromY, x, y, crossing) < 0);
}

/** The hand spot of a player at (x, y) looking along `eyeAngle`, written into `out`. */
export function holdSpot(
  map: GameMap,
  portals: Portals | null,
  x: number,
  y: number,
  eyeAngle: number,
  out: { x: number; y: number }
): { x: number; y: number } {
  const cos = Math.cos(eyeAngle);
  const sin = Math.sin(eyeAngle);
  // Right of the eye is a quarter turn clockwise, and clockwise is increasing angle on this map.
  const dx = cos * HOLD_FORWARD_TILES - sin * HOLD_SIDE_TILES;
  const dy = sin * HOLD_FORWARD_TILES + cos * HOLD_SIDE_TILES;
  let clearT = 0;
  if (reachableAt(map, portals, x, y, x + dx, y + dy)) {
    clearT = 1;
  } else {
    let blockedT = 1;
    for (let i = 0; i < PULL_BACK_STEPS; i++) {
      const t = (clearT + blockedT) / 2;
      if (reachableAt(map, portals, x, y, x + dx * t, y + dy * t)) {
        clearT = t;
      } else {
        blockedT = t;
      }
    }
  }
  out.x = x + dx * clearT;
  out.y = y + dy * clearT;
  return out;
}
