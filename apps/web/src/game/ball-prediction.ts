// The ball as this client draws it (ball spec §3.3): the shared physics run every frame with the local player as its
// only body, so the local player's pushes and kicks act at once. Everyone else's touches and the vacuum's arrive in
// the server's states, which the local ball eases onto whenever the local player hasn't touched it lately.
import {
  BALL_KICK_GAP_MS,
  BALL_RADIUS,
  type Ball,
  type BallBody,
  type BallEvent,
  ballMoving,
  createBall,
  type GameMap,
  kickBall,
  type ObjectInfo,
  type ObjectStateMessage,
  stepBall,
} from '@zoom3d/shared';

/** After the local player's last touch, server states are ignored this long: they can't include the touch yet. */
const HOLD_MS = 300;
/** A server state is about this old when it arrives, so it is advanced this far before comparing. */
const LATENCY_S = 0.06;
const EASE_S = 0.1;
const SNAP_TILES = 1.5;
/** Two balls at rest this close are one ball: snap, so every screen shows the same spot. */
const REST_SNAP_TILES = 0.05;
/** Tiles/s under which the local player counts as standing still. */
const STILL_SPEED = 0.05;
/** The server's ball already holds everyone's touches. */
const NO_BODIES: readonly BallBody[] = [];

export interface BallPrediction {
  /** The ball as drawn, or null before a welcome with one. The same object from frame to frame. */
  readonly ball: Ball | null;
  /** A welcome's ball (or none): adopts it outright, dropping any other id. */
  reset(info: ObjectInfo | null): void;
  /** A server state for the ball; `selfId` recognises the local player's own kick echo. */
  server(m: ObjectStateMessage, selfId: string | null, now: number): void;
  /** Steps the ball with the local player as its only body; returns the local event, for sound. */
  step(dt: number, now: number, self: BallBody | null): BallEvent | null;
  /** A local kick: applies at once if in reach and returns the kick counter to send, else null. */
  kick(from: { x: number; y: number }, angle: number, now: number): number | null;
}

export function createBallPrediction(map: GameMap): BallPrediction {
  let ball: Ball | null = null;
  /** The server's ball, advanced to now. */
  let server: Ball | null = null;
  const bodies: BallBody[] = [];
  let holdUntil = Number.NEGATIVE_INFINITY;
  let kicks = 0;
  let lastKickAt = Number.NEGATIVE_INFINITY;
  /** The local kick whose echo hasn't come back yet. */
  let unechoed: number | null = null;

  /**
   * Only a moving touch is one the server can't have yet: a still player against the ball is a body the server sees
   * just as well, so holding off the server for them would freeze the ball for as long as they stand there.
   */
  const pushing = (self: BallBody) =>
    ball !== null &&
    Math.hypot(self.vx, self.vy) > STILL_SPEED &&
    Math.hypot(ball.x - self.x, ball.y - self.y) < self.radius + BALL_RADIUS + 1e-6;

  const easeOntoServer = (b: Ball, s: Ball, dt: number) => {
    const error = Math.hypot(s.x - b.x, s.y - b.y);
    const atRest = !ballMoving(b) && !ballMoving(s);
    if (error > SNAP_TILES || (atRest && error <= REST_SNAP_TILES)) {
      b.x = s.x;
      b.y = s.y;
    } else {
      const alpha = 1 - Math.exp(-dt / EASE_S);
      b.x += (s.x - b.x) * alpha;
      b.y += (s.y - b.y) * alpha;
    }
    b.vx = s.vx;
    b.vy = s.vy;
  };

  return {
    get ball() {
      return ball;
    },

    reset(info) {
      ball = info && {
        ...createBall(info.id, info.x, info.y),
        vx: info.vx ?? 0,
        vy: info.vy ?? 0,
        heading: info.angle,
      };
      server = null;
      holdUntil = Number.NEGATIVE_INFINITY;
      unechoed = null;
    },

    server(m, selfId, now) {
      if (!ball || m.id !== ball.id) {
        return;
      }
      server ??= createBall(m.id, m.x, m.y);
      Object.assign(server, { x: m.x, y: m.y, vx: m.vx ?? 0, vy: m.vy ?? 0, heading: m.angle });
      stepBall(map, server, LATENCY_S, NO_BODIES);
      if (m.event === 'kick' && m.by === selfId && unechoed !== null && (m.k ?? -1) >= unechoed) {
        unechoed = null;
        holdUntil = now;
      }
    },

    step(dt, now, self) {
      if (!ball) {
        return null;
      }
      if (self && pushing(self)) {
        holdUntil = now + HOLD_MS;
      }
      if (server) {
        stepBall(map, server, dt, NO_BODIES);
        if (now >= holdUntil) {
          easeOntoServer(ball, server, dt);
        }
      }
      bodies.length = 0;
      if (self) {
        bodies.push(self);
      }
      return stepBall(map, ball, dt, bodies);
    },

    kick(from, angle, now) {
      if (!ball || now - lastKickAt < BALL_KICK_GAP_MS || !kickBall(ball, from, angle)) {
        return null;
      }
      lastKickAt = now;
      kicks++;
      unechoed = kicks;
      holdUntil = now + HOLD_MS;
      return kicks;
    },
  };
}
