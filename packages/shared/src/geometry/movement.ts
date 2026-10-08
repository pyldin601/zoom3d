// Player movement with axis-separated wall collision (slides along walls).
import { type GameMap, isWallAt } from '../map/map';

export const MOVE_SPEED = 3; // tiles/s
export const TURN_SPEED = 2.5; // rad/s
export const PLAYER_RADIUS = 0.25; // tiles
export const MAX_DT = 0.1; // s; protects against tunnelling after long frames

const TWO_PI = Math.PI * 2;

export interface PlayerState {
  x: number;
  y: number;
  /** Radians; 0 faces +x, increasing turns clockwise on the map (right). */
  angle: number;
}

/** Each in [-1, 1]. strafe +1 = right, turn +1 = turn right. */
export interface MoveInput {
  forward: number;
  strafe: number;
  turn: number;
}

function blocked(map: GameMap, x: number, y: number, r: number): boolean {
  return (
    isWallAt(map, x - r, y - r) ||
    isWallAt(map, x + r, y - r) ||
    isWallAt(map, x - r, y + r) ||
    isWallAt(map, x + r, y + r)
  );
}

export function moveWithCollision(
  map: GameMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius = PLAYER_RADIUS,
): { x: number; y: number } {
  const nx = blocked(map, x + dx, y, radius) ? x : x + dx;
  const ny = blocked(map, nx, y + dy, radius) ? y : y + dy;
  return { x: nx, y: ny };
}

export function stepPlayer(
  map: GameMap,
  s: PlayerState,
  input: MoveInput,
  dt: number,
  out: PlayerState,
): PlayerState {
  const t = Math.min(Math.max(dt, 0), MAX_DT);
  let angle = (s.angle + input.turn * TURN_SPEED * t) % TWO_PI;
  if (angle < 0) angle += TWO_PI;

  let forward = input.forward;
  let strafe = input.strafe;
  const len = Math.hypot(forward, strafe);
  if (len > 1) {
    forward /= len;
    strafe /= len;
  }
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  const step = MOVE_SPEED * t;
  // Right of facing (cos, sin) in y-down coordinates is (-sin, cos).
  const dx = (forward * cos - strafe * sin) * step;
  const dy = (forward * sin + strafe * cos) * step;

  const moved = moveWithCollision(map, s.x, s.y, dx, dy);
  out.x = moved.x;
  out.y = moved.y;
  out.angle = angle;
  return out;
}
