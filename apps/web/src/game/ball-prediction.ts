// The ball as this client draws it (ball spec §3.3): the shared physics run every frame with the local player as its
// only body, so the local player's pushes and kicks act at once. Everyone else's touches and the vacuum's arrive in
// the server's states, which the local ball eases onto whenever the local player hasn't touched it lately.
import {
  type Apparent,
  apparentPosition,
  BALL_KICK_GAP_MS,
  BALL_KICK_REACH,
  BALL_RADIUS,
  type Ball,
  type BallBody,
  type BallEvent,
  type BallMood,
  ballMoving,
  createBall,
  type GameMap,
  holdSpot,
  kickBall,
  type ObjectInfo,
  type ObjectStateMessage,
  type Point,
  type Portals,
  stepBall,
} from '@zoom3d/shared';
import { createBallDribble, stepBallDribble } from './ball-dribble';
import { createBallHop, dropBallHop, dropBallHopFrom, kickBallHop, knockBallHop, stepBallHop } from './ball-hop';

/** After the local player's last touch, server states are ignored this long: they can't include the touch yet. */
const HOLD_MS = 300;
/**
 * More than a push's latency can explain: someone else's kick, or a bounce off a body only the server has, has moved
 * the ball. Holding on would leave it to snap across the gap when the player finally stops touching it.
 */
const PUSH_DRIFT_TILES = 1;
/** A kick holds until the server answers, however slow the link; this is for an answer that never comes. */
const ANSWER_WAIT_MS = 1000;
/** A server state is about this old when it arrives, so it is advanced this far before comparing. */
const LATENCY_S = 0.06;
const EASE_S = 0.1;
/** Above any kick's error: a rolling ball someone reverses is about 2.5 tiles from its state, and should glide there. */
const SNAP_TILES = 3;
/** Two balls at rest this close are one ball: snap, so every screen shows the same spot. */
const REST_SNAP_TILES = 0.05;
/** Tiles/s under which the local player counts as standing still. */
const STILL_SPEED = 0.05;
/** The server's ball already holds everyone's touches. */
const NO_BODIES: readonly BallBody[] = [];

export interface BallPrediction {
  /** The ball as drawn, or null before a welcome with one. The same object from frame to frame. */
  readonly ball: Ball | null;
  /** The mood to show, as of the last step: the server's, except that a local kick sleeps it until it is answered. */
  readonly mood: BallMood;
  /** How high to draw it, in tiles: never part of where it is (game/ball-hop.ts, game/ball-dribble.ts). */
  readonly lift: number;
  /** The local player dribbles it, as far as this screen knows: asked for and not refused, or the server says so. */
  readonly holding: boolean;
  /** Someone else dribbling it, by the server's last word; null when loose or the local player's. */
  readonly heldBy: string | null;
  /** The dribble touched the floor on the last step, for its sound. */
  readonly dribbleTouch: boolean;
  /** Picks it up into a dribble if it is in reach and loose; returns whether it did, so the ask goes out. */
  pickUp(from: Point, now: number): boolean;
  /** Lets go of the local dribble: it rolls on with how the local player moved. */
  letGo(now: number): void;
  /** The server turned the local pick-up down. */
  dribbleRefused(now: number): void;
  /** Where a player at (x, y) looking along `eyeAngle` holds it, written into `out`. */
  holdAt(x: number, y: number, eyeAngle: number, out: Point): Point;
  /** Dev only: shows this mood whatever the server says, until lifted with null. */
  forceMood(mood: BallMood | null): void;
  /** A welcome's ball (or none): adopts it outright, dropping any other id. `selfId` recognises a resumed dribble. */
  reset(info: ObjectInfo | null, selfId?: string | null): void;
  /** A server state for the ball; `selfId` recognises the local player's own kick echo. */
  server(m: ObjectStateMessage, selfId: string | null, now: number): void;
  /** The server turned down the local kick `k`: if it's the latest, the server's ball is right again. */
  refused(k: number, now: number): void;
  /**
   * Steps the ball with the local player as its only body; returns the local event, for sound. A dribbled ball is put
   * at the local player's hand, looking along `eyeAngle`.
   */
  step(dt: number, now: number, self: BallBody | null, eyeAngle?: number): BallEvent | null;
  /** A local kick (a throw while dribbling): applies at once if in reach and returns the kick counter, else null. */
  kick(from: { x: number; y: number }, angle: number, now: number): number | null;
}

/**
 * `portals` is asked every step: the room's wiring while its portals are on, else null. Like the server, the
 * prediction sees the local player where they appear from the ball and turns their kick into the ball's frame.
 */
export function createBallPrediction(map: GameMap, portals: () => Portals | null = () => null): BallPrediction {
  let ball: Ball | null = null;
  /** The server's ball, advanced to now. */
  let server: Ball | null = null;
  const bodies: BallBody[] = [];
  const seen: Apparent = { x: 0, y: 0, sees: false, through: 0, cos: 1, sin: 0 };
  /** The local player as the ball sees them through a portal. */
  const seenBody: BallBody = { kind: 'person', x: 0, y: 0, vx: 0, vy: 0, radius: 0 };
  let holdUntil = Number.NEGATIVE_INFINITY;
  let kicks = 0;
  let lastKickAt = Number.NEGATIVE_INFINITY;
  /** The local kick whose echo hasn't come back yet. */
  let unechoed: number | null = null;
  let serverMood: BallMood = 'asleep';
  let shownMood: BallMood = 'asleep';
  let forcedMood: BallMood | null = null;
  let hop = createBallHop();
  const dribble = createBallDribble();
  let dribbleTouch = false;
  /**
   * The local dribble: `asked` until the server's answer, `held` once it says so, `letGo` from a release or throw
   * until a state without the local player as holder (the ones already on their way still name them).
   */
  let own: 'none' | 'asked' | 'held' | 'letGo' = 'none';
  let ownSince = Number.NEGATIVE_INFINITY;
  let otherHolder: string | null = null;
  /** The kick that threw the local dribble, which a refusal undoes. */
  let throwK: number | null = null;
  const lastSelf = { vx: 0, vy: 0 };
  const holding = () => own === 'asked' || own === 'held';
  const moodShown = () => (holding() || otherHolder !== null ? 'asleep' : (forcedMood ?? shownMood));
  const setOwn = (next: typeof own, now: number) => {
    own = next;
    ownSince = now;
  };
  /** A dribble ended: the drawn ball falls from where it was bouncing. */
  const fallFromDribble = () => dropBallHopFrom(hop, dribble.liftTiles);
  const startDribble = () => {
    const fresh = createBallDribble();
    dribble.liftTiles = fresh.liftTiles;
    dribble.phase = fresh.phase;
  };

  /** Where `from` appears from the ball, turned into the ball's frame (the identity without portals). */
  const seenFromBall = (wiring: Portals | null, from: { x: number; y: number }): Apparent => {
    if (wiring === null || ball === null) {
      seen.x = from.x;
      seen.y = from.y;
      seen.cos = 1;
      seen.sin = 0;
      return seen;
    }
    return apparentPosition(map, wiring, ball, from, seen, 1);
  };

  const bodySeenFromBall = (wiring: Portals | null, self: BallBody): BallBody => {
    if (wiring === null) {
      return self;
    }
    const apparent = seenFromBall(wiring, self);
    seenBody.x = apparent.x;
    seenBody.y = apparent.y;
    seenBody.vx = apparent.cos * self.vx - apparent.sin * self.vy;
    seenBody.vy = apparent.sin * self.vx + apparent.cos * self.vy;
    seenBody.radius = self.radius;
    return seenBody;
  };

  /**
   * Only a moving touch is one the server can't have yet: a still player against the ball is a body the server sees
   * just as well, so holding off the server for them would freeze the ball for as long as they stand there.
   */
  const pushing = (self: BallBody) =>
    ball !== null &&
    Math.hypot(self.vx, self.vy) > STILL_SPEED &&
    Math.hypot(ball.x - self.x, ball.y - self.y) < self.radius + BALL_RADIUS + 1e-6;

  const pushDriftedFrom = (b: Ball, s: Ball) =>
    unechoed === null && Math.hypot(s.x - b.x, s.y - b.y) > PUSH_DRIFT_TILES;

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

  /** What a server state says about who dribbles it, against what this screen already did. */
  const followHolder = (holder: string | null, selfId: string | null, now: number) => {
    if (holder !== null && holder === selfId) {
      if (own === 'asked') {
        setOwn('held', now);
      }
      return;
    }
    if (holder !== null) {
      otherHolder = holder;
      return;
    }
    if (otherHolder !== null) {
      otherHolder = null;
      fallFromDribble();
    }
    if (own === 'held') {
      // Knocked loose by someone else.
      setOwn('none', now);
      holdUntil = now;
      fallFromDribble();
    } else if (own === 'letGo') {
      setOwn('none', now);
    }
  };

  return {
    get ball() {
      return ball;
    },

    get mood() {
      return moodShown();
    },

    get lift() {
      return holding() || otherHolder !== null ? dribble.liftTiles : hop.liftTiles;
    },

    get holding() {
      return holding();
    },

    get heldBy() {
      return otherHolder;
    },

    get dribbleTouch() {
      return dribbleTouch;
    },

    pickUp(from, now) {
      if (!ball || holding() || otherHolder !== null) {
        return false;
      }
      const dribbler = seenFromBall(portals(), from);
      if (Math.hypot(dribbler.x - ball.x, dribbler.y - ball.y) > BALL_KICK_REACH) {
        return false;
      }
      setOwn('asked', now);
      startDribble();
      return true;
    },

    letGo(now) {
      if (!holding() || !ball) {
        return;
      }
      setOwn('letGo', now);
      ball.vx = lastSelf.vx;
      ball.vy = lastSelf.vy;
      holdUntil = now + ANSWER_WAIT_MS;
      fallFromDribble();
    },

    dribbleRefused(now) {
      if (own === 'asked') {
        setOwn('none', now);
        holdUntil = now;
        fallFromDribble();
      }
    },

    holdAt(x, y, eyeAngle, out) {
      return holdSpot(map, portals(), x, y, eyeAngle, out);
    },

    forceMood(mood) {
      forcedMood = mood;
    },

    reset(info, selfId = null) {
      ball = info && {
        ...createBall(info.id, info.x, info.y),
        vx: info.vx ?? 0,
        vy: info.vy ?? 0,
        heading: info.angle,
      };
      // A copy, not null: a refused kick has to find its way back to a ball that no state has mentioned yet.
      server = ball && { ...ball };
      holdUntil = Number.NEGATIVE_INFINITY;
      unechoed = null;
      hop = createBallHop();
      serverMood = info?.mood ?? 'asleep';
      shownMood = serverMood;
      const holder = info?.heldBy ?? null;
      own = holder !== null && holder === selfId ? 'held' : 'none';
      ownSince = Number.NEGATIVE_INFINITY;
      otherHolder = holder !== null && holder !== selfId ? holder : null;
      throwK = null;
      startDribble();
    },

    server(m, selfId, now) {
      if (!ball || m.id !== ball.id) {
        return;
      }
      followHolder(m.heldBy ?? null, selfId, now);
      server ??= createBall(m.id, m.x, m.y);
      Object.assign(server, { x: m.x, y: m.y, vx: m.vx ?? 0, vy: m.vy ?? 0, heading: m.angle });
      stepBall(map, server, LATENCY_S, NO_BODIES, portals());
      serverMood = m.mood ?? 'asleep';
      // The vacuum's knock has no `by`. The local player's own kick already hopped when it was made.
      if (m.event === 'kick' && m.by === undefined) {
        knockBallHop(hop);
      } else if (m.event === 'kick' && m.by !== selfId) {
        kickBallHop(hop);
      }
      if (m.event === 'kick' && m.by === selfId && unechoed !== null && (m.k ?? -1) >= unechoed) {
        unechoed = null;
        holdUntil = now;
      }
    },

    refused(k, now) {
      if (throwK !== null && k === throwK && own === 'letGo') {
        // The server kept it in the dribbler's hand.
        setOwn('held', now);
        throwK = null;
        unechoed = null;
        startDribble();
        return;
      }
      if (unechoed !== null && k >= unechoed) {
        unechoed = null;
        holdUntil = now;
        dropBallHop(hop);
      }
    },

    step(dt, now, self, eyeAngle = 0) {
      shownMood = unechoed !== null && now < holdUntil ? 'asleep' : serverMood;
      dribbleTouch = false;
      if (!ball) {
        return null;
      }
      if (own === 'asked' && now - ownSince > ANSWER_WAIT_MS) {
        setOwn('none', now);
        holdUntil = now;
        fallFromDribble();
      }
      const wiring = portals();
      if (holding() || otherHolder !== null) {
        dribbleTouch = stepBallDribble(dribble, dt);
        if (server) {
          stepBall(map, server, dt, NO_BODIES, wiring);
        }
        if (holding() && self) {
          holdSpot(map, wiring, self.x, self.y, eyeAngle, ball);
          ball.vx = self.vx;
          ball.vy = self.vy;
          lastSelf.vx = self.vx;
          lastSelf.vy = self.vy;
        } else if (!holding() && server) {
          ball.x = server.x;
          ball.y = server.y;
          ball.vx = server.vx;
          ball.vy = server.vy;
        }
        return null;
      }
      stepBallHop(hop, dt, moodShown());
      const body = self && bodySeenFromBall(wiring, self);
      if (body && pushing(body)) {
        holdUntil = Math.max(holdUntil, now + HOLD_MS);
      }
      if (server) {
        stepBall(map, server, dt, NO_BODIES, wiring);
        if (now >= holdUntil || pushDriftedFrom(ball, server)) {
          easeOntoServer(ball, server, dt);
        }
      }
      bodies.length = 0;
      if (body) {
        bodies.push(body);
      }
      return stepBall(map, ball, dt, bodies, wiring);
    },

    kick(from, angle, now) {
      if (!ball || now - lastKickAt < BALL_KICK_GAP_MS) {
        return null;
      }
      const throwing = holding();
      const kicker = seenFromBall(portals(), from);
      if (!kickBall(ball, kicker, angle + Math.atan2(kicker.sin, kicker.cos))) {
        return null;
      }
      lastKickAt = now;
      if (throwing) {
        setOwn('letGo', now);
        fallFromDribble();
      }
      if (otherHolder !== null) {
        // A steal: the ball leaves the other dribbler's hand here at once.
        otherHolder = null;
        fallFromDribble();
      }
      kickBallHop(hop);
      shownMood = 'asleep';
      kicks++;
      unechoed = kicks;
      throwK = throwing ? kicks : null;
      holdUntil = now + ANSWER_WAIT_MS;
      return kicks;
    },
  };
}
