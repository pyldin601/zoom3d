// The ball (ball spec §2): rolls on the floor with constant friction and bounces off walls, people and the robot
// vacuum. Pure, so the server and every client run the same physics. No allocations per step.
import { MOVE_SPEED, PLAYER_RADIUS } from '../../geometry/movement';
import { type GameMap, isWallAt } from '../../map/map';
import { carryThroughPortal } from '../../portals/crossing';
import type { Portals } from '../../portals/wiring';
import type { ObjectInfo } from '../../protocol/protocol';
import { mapFingerprint } from '../vacuum/nav';

export const BALL_RADIUS = 0.2; // tiles
/** Rolling friction as a constant deceleration, tiles/s²: a kick rolls about 16 tiles. */
export const BALL_FRICTION = 2;
export const BALL_KICK_SPEED = 8; // tiles/s
/** A squeeze between two people can't launch it faster than this, tiles/s. */
export const BALL_MAX_SPEED = 10;
/** One kick per person per this long; the server drops the rest, so clients don't make them either. */
export const BALL_KICK_GAP_MS = 250;
/** How far from the ball's centre a kicker may stand. */
export const BALL_KICK_REACH = PLAYER_RADIUS + BALL_RADIUS + 0.5;
const WALL_RESTITUTION = 0.6;
const BODY_RESTITUTION = 0.4;
/** A walker sends it a little faster than they walk, so it rolls ahead of their feet instead of sticking to them. */
const PUSH_FACTOR = 1.2;
/**
 * A body's speed as the ball feels it is capped at a brisk walk: a person's velocity comes from pose messages, and two
 * that arrive bunched after a network stall read as hundreds of tiles/s.
 */
const BODY_MAX_SPEED = MOVE_SPEED * 1.5;
/** The hardest a push can send it. */
export const BALL_PUSH_MAX_SPEED = BODY_MAX_SPEED * PUSH_FACTOR;
/** The vacuum's 0.6 tiles/s would barely nudge it, so a vacuum driving into it kicks it at least this fast. */
const VACUUM_KICK_SPEED = 2.5;
const STOP_SPEED = 0.05;
/** A hit slower than this along its normal makes no sound. */
const BOUNCE_EVENT_SPEED = 1;
/** No sub-step moves the ball more than half its radius, even at its top speed. */
const SUBSTEP_S = BALL_RADIUS / 2 / BALL_MAX_SPEED;
/** A longer step (a stalled tab) is cut to this, which still rolls it far. */
const MAX_STEP_S = 1;

/** Where a roll that crossed a portal is carried, so stepping allocates nothing. */
const carried = { x: 0, y: 0, angle: 0 };

export type BallEvent = 'kick' | 'bounce';

export interface Ball {
  id: string;
  x: number;
  y: number;
  /** Tiles/s. */
  vx: number;
  vy: number;
  /** The direction it last rolled in, radians; sent as its angle. */
  heading: number;
  seq: number;
}

/** Something the ball collides with: a person (moving or still) or the vacuum. */
export interface BallBody {
  kind: 'person' | 'vacuum';
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface BallSave {
  x: number;
  y: number;
  /** `mapFingerprint` of the map it was saved on. */
  map: string;
}

export function createBall(id: string, x: number, y: number): Ball {
  return { id, x, y, vx: 0, vy: 0, heading: 0, seq: 0 };
}

export function ballMoving(ball: Ball): boolean {
  return ball.vx !== 0 || ball.vy !== 0;
}

export function ballInfo(ball: Ball): ObjectInfo {
  return { id: ball.id, kind: 'ball', x: ball.x, y: ball.y, angle: ball.heading, vx: ball.vx, vy: ball.vy };
}

/** Kicks it the way `angle` faces if `from` is within reach (plus `slack`, for a kicker seen late). */
export function kickBall(ball: Ball, from: { x: number; y: number }, angle: number, slack = 0): boolean {
  if (Math.hypot(ball.x - from.x, ball.y - from.y) > BALL_KICK_REACH + slack) {
    return false;
  }
  ball.vx = Math.cos(angle) * BALL_KICK_SPEED;
  ball.vy = Math.sin(angle) * BALL_KICK_SPEED;
  ball.heading = angle;
  return true;
}

/**
 * Advances by dt seconds against the map's walls and the bodies; returns this step's event, a kick over a bounce.
 * With `portals`, it rolls through them; the bodies must already be at their apparent positions from the ball.
 */
export function stepBall(
  map: GameMap,
  ball: Ball,
  dt: number,
  bodies: readonly BallBody[],
  portals: Portals | null = null
): BallEvent | null {
  const t = Math.min(Math.max(dt, 0), MAX_STEP_S);
  const steps = Math.max(1, Math.ceil(t / SUBSTEP_S));
  const h = t / steps;
  let event: BallEvent | null = null;
  const note = (e: BallEvent) => {
    if (event !== 'kick') {
      event = e;
    }
  };
  for (let i = 0; i < steps; i++) {
    // Before the bodies: a shove moves the ball too, and may take it across a plane.
    const { x, y } = ball;
    for (const body of bodies) {
      collide(map, ball, body, note);
    }
    roll(map, ball, h, note);
    if (portals !== null) {
      carryBall(portals, ball, x, y);
    }
    slow(ball, h);
  }
  if (ballMoving(ball)) {
    ball.heading = Math.atan2(ball.vy, ball.vx);
  }
  return event;
}

function collide(map: GameMap, ball: Ball, body: BallBody, note: (e: BallEvent) => void): void {
  const dx = ball.x - body.x;
  const dy = ball.y - body.y;
  const distance = Math.hypot(dx, dy);
  const touching = BALL_RADIUS + body.radius;
  if (distance >= touching) {
    return;
  }
  // The normal points from the body to the ball. On the body's centre there is none: go the way the body moves.
  const bodySpeed = Math.hypot(body.vx, body.vy);
  let nx = 1;
  let ny = 0;
  if (distance > 1e-9) {
    nx = dx / distance;
    ny = dy / distance;
  } else if (bodySpeed > 0) {
    nx = body.vx / bodySpeed;
    ny = body.vy / bodySpeed;
  }
  slide(map, ball, nx * (touching - distance), ny * (touching - distance));
  const ballNormal = ball.vx * nx + ball.vy * ny;
  const bodyNormal = Math.min(body.vx * nx + body.vy * ny, BODY_MAX_SPEED);
  if (bodyNormal > 0) {
    const pushed = bodyNormal * PUSH_FACTOR;
    const target = body.kind === 'vacuum' ? Math.max(pushed, VACUUM_KICK_SPEED) : pushed;
    if (ballNormal < target) {
      ball.vx += (target - ballNormal) * nx;
      ball.vy += (target - ballNormal) * ny;
      if (body.kind === 'vacuum') {
        note('kick');
      }
    }
  } else if (ballNormal < 0) {
    ball.vx -= (1 + BODY_RESTITUTION) * ballNormal * nx;
    ball.vy -= (1 + BODY_RESTITUTION) * ballNormal * ny;
    if (-ballNormal > BOUNCE_EVENT_SPEED) {
      note('bounce');
    }
  }
}

/** Moves by its velocity over h, reflecting each axis a wall blocks. */
function roll(map: GameMap, ball: Ball, h: number, note: (e: BallEvent) => void): void {
  if (blocked(map, ball.x + ball.vx * h, ball.y)) {
    if (Math.abs(ball.vx) > BOUNCE_EVENT_SPEED) {
      note('bounce');
    }
    ball.vx = -ball.vx * WALL_RESTITUTION;
  } else {
    ball.x += ball.vx * h;
  }
  if (blocked(map, ball.x, ball.y + ball.vy * h)) {
    if (Math.abs(ball.vy) > BOUNCE_EVENT_SPEED) {
      note('bounce');
    }
    ball.vy = -ball.vy * WALL_RESTITUTION;
  } else {
    ball.y += ball.vy * h;
  }
}

/** Carries the ball through the portal it rolled into from (fromX, fromY), turning its velocity with it. */
function carryBall(portals: Portals, ball: Ball, fromX: number, fromY: number): void {
  carried.x = ball.x;
  carried.y = ball.y;
  if (carryThroughPortal(portals, fromX, fromY, carried, ball)) {
    ball.x = carried.x;
    ball.y = carried.y;
  }
}

/** Moves without bouncing, as far as the walls allow on each axis: how a body shoves it out of the way. */
function slide(map: GameMap, ball: Ball, dx: number, dy: number): void {
  if (!blocked(map, ball.x + dx, ball.y)) {
    ball.x += dx;
  }
  if (!blocked(map, ball.x, ball.y + dy)) {
    ball.y += dy;
  }
}

function slow(ball: Ball, h: number): void {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed === 0) {
    return;
  }
  const slowed = Math.min(speed - BALL_FRICTION * h, BALL_MAX_SPEED);
  if (slowed < STOP_SPEED) {
    ball.vx = 0;
    ball.vy = 0;
    return;
  }
  ball.vx *= slowed / speed;
  ball.vy *= slowed / speed;
}

function blocked(map: GameMap, x: number, y: number): boolean {
  const r = BALL_RADIUS;
  return (
    isWallAt(map, x - r, y - r) ||
    isWallAt(map, x + r, y - r) ||
    isWallAt(map, x - r, y + r) ||
    isWallAt(map, x + r, y + r)
  );
}

export function saveBall(map: GameMap, ball: Ball): BallSave {
  return { x: ball.x, y: ball.y, map: mapFingerprint(map) };
}

/** A saved ball at rest under a new id, or null if it was saved on another map or would sit in a wall. */
export function restoreBall(map: GameMap, save: BallSave, id: string): Ball | null {
  if (save.map !== mapFingerprint(map) || blocked(map, save.x, save.y)) {
    return null;
  }
  return createBall(id, save.x, save.y);
}
