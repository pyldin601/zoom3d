// The ball's personality, a curious puppy (living ball spec §2): a state machine the server runs before the physics.
// It only ever sets a velocity at or below its own speed, and only once a kick, push or bounce has played out, so it
// can't get in the way of the ball being a ball.
import { PLAYER_RADIUS } from '../../geometry/movement';
import type { GameMap } from '../../map/map';
import { type Apparent, apparentPosition, hasPortalLineOfSight } from '../../portals/apparent';
import type { Portals } from '../../portals/wiring';
import type { BallCry, BallMood } from '../../protocol/protocol';
import { BALL_RADIUS, type Ball, type BallTouch, ballBlockedAt } from './ball';
import { BALL_CRIES } from './cries';

/** Tiles/s: a person walks at 3, so anyone can catch it. */
export const BALL_OWN_SPEED = 2;
export const BALL_WAKE_S = 10;
export const BALL_SEES_TILES = 6;
const TOUCHING_TILES = PLAYER_RADIUS + BALL_RADIUS;
/** Not touching, so it isn't a push, and still within kick reach. */
export const BALL_STOP_TILES = TOUCHING_TILES + 0.25;
/** Beyond this it follows, so small shuffles don't set off a chase. */
const PLAY_LEAVE_TILES = TOUCHING_TILES + 1;
const CHASE_S = 6;
const SCARED_S = 6;
const IGNORE_S = 15;
const FORGIVE_TILES = 2;
export const BALL_CRY_COOLDOWN_S = 3;
const GIGGLE_CALM_S = 5;
/** Playing, it dashes to spots this far from its person: clear of them, and close enough to be kicked soon. */
const PLAY_MIN_TILES = TOUCHING_TILES + 0.35;
const PLAY_MAX_TILES = TOUCHING_TILES + 0.85;
/** Each dash swings this far around its person, so it never cuts through them. */
const PLAY_SWING_MIN_RADIANS = 0.6;
const PLAY_SWING_MAX_RADIANS = 1.8;
const PLAY_DASH_S = 1;
const PLAY_REST_MIN_S = 0.2;
const PLAY_REST_MAX_S = 0.8;
const WANDER_MIN_TILES = 1;
const WANDER_MAX_TILES = 3;
const WANDER_TARGET_S = 5;
const WANDER_PAUSE_MIN_S = 0.5;
const WANDER_PAUSE_MAX_S = 2;
/** In a one-tile corridor only about one try in twenty finds a spot, and a miss shouldn't show as a longer rest. */
const WANDER_TRIES_PER_TICK = 8;
/** Its own steering can round to just above its own speed, and mustn't count as being pushed. */
const SPEED_ROUNDING = 1e-6;
/** This close to a spot counts as there. */
const ARRIVED_TILES = 0.2;
/** Tiles/s: a wall has left it less than this along its way, so the spot isn't worth creeping towards. */
const HEADWAY_SPEED = BALL_OWN_SPEED / 2;
/** A corner further off than this isn't the way round: it is a wall to slide along. */
const CORNER_SEARCH_TILES = 0.5;
const CORNER_PROBE_TILES = 0.05;

interface Spot {
  x: number;
  y: number;
}

type Chasing = { person: string; lastSeen: Spot; chaseLeftS: number };

type MindState =
  | { mood: 'asleep'; secondsLeft: number; lost: boolean }
  | { mood: 'wandering'; target: Spot | null; secondsLeft: number }
  | ({ mood: 'approaching' } & Chasing)
  | { mood: 'playing'; person: string; lastSeen: Spot; dash: Spot | null; secondsLeft: number }
  | ({ mood: 'following' } & Chasing)
  | { mood: 'scared'; secondsLeft: number };

export interface BallMind {
  readonly mood: BallMood;
  state: MindState;
  cooldownLeftS: number;
  sinceLastPushS: number;
  /** Each person it gave up on. Only coming back forgives them, so they must have been away first. */
  ignored: Map<string, { secondsLeft: number; beenAway: boolean }>;
  lastVariants: Map<BallCry, number>;
}

export interface BallSenses {
  people: readonly { id: string; x: number; y: number }[];
  touch: BallTouch;
  portals?: Portals | null;
}

export interface BallCryChoice {
  cry: BallCry;
  variant: number;
}

/** Someone as the ball sees them: where they appear from it, one portal deep at most, as it feels them. */
interface Person {
  id: string;
  x: number;
  y: number;
  inSight: boolean;
}

const apparent: Apparent = { x: 0, y: 0, sees: false, through: 0, cos: 1, sin: 0 };

export function createBallMind(): BallMind {
  return {
    get mood() {
      return this.state.mood;
    },
    state: fallAsleep(false),
    cooldownLeftS: 0,
    sinceLastPushS: Number.POSITIVE_INFINITY,
    ignored: new Map(),
    lastVariants: new Map(),
  };
}

function fallAsleep(lost: boolean): MindState {
  return { mood: 'asleep', secondsLeft: BALL_WAKE_S, lost };
}

/** A person's kick: always wins. Only the yelp ignores the cooldown, and only an awake ball yelps. */
export function kickBallMind(mind: BallMind, rng: () => number): BallCryChoice | null {
  const { state } = mind;
  mind.state = fallAsleep(state.mood === 'asleep' && state.lost);
  return state.mood === 'asleep' ? null : voice(mind, 'yelp', rng);
}

/** One tick, before the physics. Returns what it says this tick. */
export function stepBallMind(
  map: GameMap,
  mind: BallMind,
  ball: Ball,
  dt: number,
  senses: BallSenses,
  rng: () => number
): BallCryChoice | null {
  const say = (cry: BallCry) => (mind.cooldownLeftS > 0 ? null : voice(mind, cry, rng));
  const portals = senses.portals ?? null;
  const people = senses.people.map((person) => asSeenBy(map, portals, ball, person));
  passTime(mind, ball, dt, people);
  const cry = reactToTouch(mind, ball, people, senses.touch, say);
  if (mind.state.mood === 'asleep') {
    return cry ?? sleep(mind, ball, dt, people, rng, say);
  }
  if (Math.hypot(ball.vx, ball.vy) > BALL_OWN_SPEED + SPEED_ROUNDING) {
    return cry;
  }
  return cry ?? behave(map, portals, mind, ball, dt, people, rng, say);
}

function asSeenBy(map: GameMap, portals: Portals | null, ball: Ball, person: BallSenses['people'][number]): Person {
  const { x, y, sees } = apparentPosition(map, portals, ball, person, apparent, 1);
  return { id: person.id, x, y, inSight: sees };
}

function passTime(mind: BallMind, ball: Ball, dt: number, people: readonly Person[]): void {
  mind.cooldownLeftS = Math.max(0, mind.cooldownLeftS - dt);
  mind.sinceLastPushS += dt;
  for (const [id, ignoring] of mind.ignored) {
    const person = people.find((p) => p.id === id);
    const near = person !== undefined && distance(ball, person) <= FORGIVE_TILES;
    ignoring.secondsLeft -= dt;
    ignoring.beenAway ||= !near;
    if ((near && ignoring.beenAway) || ignoring.secondsLeft <= 0) {
      mind.ignored.delete(id);
    }
  }
}

function reactToTouch(
  mind: BallMind,
  ball: Ball,
  people: readonly Person[],
  touch: BallTouch,
  say: (cry: BallCry) => BallCryChoice | null
): BallCryChoice | null {
  const { state } = mind;
  const calmed = mind.sinceLastPushS >= GIGGLE_CALM_S;
  if (touch.pushed) {
    mind.sinceLastPushS = 0;
  }
  if (state.mood === 'asleep') {
    state.lost ||= touch.crossedPortal;
    return null;
  }
  let cry: BallCryChoice | null = null;
  if (touch.crossedPortal) {
    const person = nearestSeen(mind, ball, people);
    if (person) {
      // A crossing doesn't reset a chase of the same person, or doorways could keep it going for ever.
      const sameChase = (state.mood === 'approaching' || state.mood === 'following') && state.person === person.id;
      mind.state = chase('approaching', person, sameChase ? state.chaseLeftS : CHASE_S);
      cry = say('yip');
    } else {
      mind.state = { mood: 'scared', secondsLeft: SCARED_S };
      rollOn(ball);
      cry = say('whimper');
    }
  }
  if (touch.pushed && calmed) {
    cry ??= say('giggle');
  }
  if (touch.knocked) {
    cry ??= say('startled');
  }
  return cry;
}

function sleep(
  mind: BallMind,
  ball: Ball,
  dt: number,
  people: readonly Person[],
  rng: () => number,
  say: (cry: BallCry) => BallCryChoice | null
): BallCryChoice | null {
  const { state } = mind;
  if (state.mood !== 'asleep') {
    return null;
  }
  state.secondsLeft -= dt;
  if (state.secondsLeft > 0) {
    return null;
  }
  if (state.lost && nearestSeen(mind, ball, people) === null) {
    mind.state = { mood: 'scared', secondsLeft: SCARED_S };
    return say('whimper');
  }
  mind.state = paused(rng);
  return say('yawn');
}

function behave(
  map: GameMap,
  portals: Portals | null,
  mind: BallMind,
  ball: Ball,
  dt: number,
  people: readonly Person[],
  rng: () => number,
  say: (cry: BallCry) => BallCryChoice | null
): BallCryChoice | null {
  const { state } = mind;
  switch (state.mood) {
    case 'asleep':
      return null;
    case 'wandering': {
      const person = nearestSeen(mind, ball, people);
      if (person) {
        mind.state = chase('approaching', person);
        return say('happy');
      }
      wander(map, portals, mind, ball, dt, rng);
      return null;
    }
    case 'scared': {
      const person = nearestSeen(mind, ball, people);
      if (person) {
        mind.state = chase('approaching', person);
        return say('relieved');
      }
      state.secondsLeft -= dt;
      if (state.secondsLeft <= 0) {
        mind.state = paused(rng);
      }
      return null;
    }
    case 'playing': {
      const person = visiblePerson(ball, people, state.person);
      if (person) {
        state.lastSeen = { x: person.x, y: person.y };
      }
      if (!person || distance(ball, person) > PLAY_LEAVE_TILES) {
        mind.state = { mood: 'following', person: state.person, lastSeen: state.lastSeen, chaseLeftS: CHASE_S };
        return null;
      }
      play(map, portals, state, ball, person, dt, rng);
      return null;
    }
    case 'approaching':
    case 'following': {
      state.chaseLeftS -= dt;
      const person = visiblePerson(ball, people, state.person);
      if (person) {
        state.lastSeen = { x: person.x, y: person.y };
        if (distance(ball, person) <= BALL_STOP_TILES) {
          stop(ball);
          mind.state = {
            mood: 'playing',
            person: state.person,
            lastSeen: state.lastSeen,
            dash: null,
            secondsLeft: playRestS(rng),
          };
          return null;
        }
      } else if (state.mood === 'approaching') {
        mind.state = { ...state, mood: 'following' };
      }
      const nobodyAtLastSeen = !person && distance(ball, state.lastSeen) <= ARRIVED_TILES;
      if (state.chaseLeftS <= 0 || nobodyAtLastSeen) {
        stop(ball);
        mind.ignored.set(state.person, { secondsLeft: IGNORE_S, beenAway: false });
        mind.state = paused(rng);
        return say('sad');
      }
      steer(map, ball, state.lastSeen, dt);
      return null;
    }
  }
}

function play(
  map: GameMap,
  portals: Portals | null,
  state: Extract<MindState, { mood: 'playing' }>,
  ball: Ball,
  person: Person,
  dt: number,
  rng: () => number
): void {
  state.secondsLeft -= dt;
  if (state.dash === null) {
    if (state.secondsLeft <= 0) {
      state.dash = playSpot(map, portals, ball, person, rng);
      state.secondsLeft = state.dash ? PLAY_DASH_S : playRestS(rng);
    }
    return;
  }
  if (state.secondsLeft <= 0 || distance(ball, state.dash) <= ARRIVED_TILES || !steer(map, ball, state.dash, dt)) {
    stop(ball);
    state.dash = null;
    state.secondsLeft = playRestS(rng);
  }
}

function playSpot(map: GameMap, portals: Portals | null, ball: Ball, person: Person, rng: () => number): Spot | null {
  const side = rng() < 0.5 ? -1 : 1;
  const swing = PLAY_SWING_MIN_RADIANS + rng() * (PLAY_SWING_MAX_RADIANS - PLAY_SWING_MIN_RADIANS);
  const angle = Math.atan2(ball.y - person.y, ball.x - person.x) + side * swing;
  const tiles = PLAY_MIN_TILES + rng() * (PLAY_MAX_TILES - PLAY_MIN_TILES);
  const x = person.x + Math.cos(angle) * tiles;
  const y = person.y + Math.sin(angle) * tiles;
  return reachable(map, portals, ball, x, y) ? { x, y } : null;
}

function playRestS(rng: () => number): number {
  return PLAY_REST_MIN_S + rng() * (PLAY_REST_MAX_S - PLAY_REST_MIN_S);
}

function wander(
  map: GameMap,
  portals: Portals | null,
  mind: BallMind,
  ball: Ball,
  dt: number,
  rng: () => number
): void {
  const { state } = mind;
  if (state.mood !== 'wandering') {
    return;
  }
  state.secondsLeft -= dt;
  if (state.target === null) {
    // A pause leaves the ball to its friction: a slow roll carries on and comes to rest by itself.
    if (state.secondsLeft <= 0) {
      // No spot leaves it trying again next tick, not taking a whole new pause.
      const target = wanderSpot(map, portals, ball, rng);
      if (target) {
        mind.state = { mood: 'wandering', target, secondsLeft: WANDER_TARGET_S };
      }
    }
    return;
  }
  if (state.secondsLeft <= 0 || distance(ball, state.target) <= ARRIVED_TILES) {
    stop(ball);
    mind.state = paused(rng);
  } else if (!steer(map, ball, state.target, dt)) {
    stop(ball);
    mind.state = { mood: 'wandering', target: null, secondsLeft: 0 };
  }
}

function wanderSpot(map: GameMap, portals: Portals | null, ball: Ball, rng: () => number): Spot | null {
  for (let i = 0; i < WANDER_TRIES_PER_TICK; i++) {
    const angle = rng() * Math.PI * 2;
    const tiles = WANDER_MIN_TILES + rng() * (WANDER_MAX_TILES - WANDER_MIN_TILES);
    const x = ball.x + Math.cos(angle) * tiles;
    const y = ball.y + Math.sin(angle) * tiles;
    if (reachable(map, portals, ball, x, y)) {
      return { x, y };
    }
  }
  return null;
}

/** Line of sight doesn't look at the last tile, so the spot itself must be checked too. */
function reachable(map: GameMap, portals: Portals | null, ball: Ball, x: number, y: number): boolean {
  return !ballBlockedAt(map, x, y) && hasPortalLineOfSight(map, portals, ball.x, ball.y, x, y);
}

function paused(rng: () => number): MindState {
  const pauseS = WANDER_PAUSE_MIN_S + rng() * (WANDER_PAUSE_MAX_S - WANDER_PAUSE_MIN_S);
  return { mood: 'wandering', target: null, secondsLeft: pauseS };
}

function chase(mood: 'approaching', person: Person, chaseLeftS = CHASE_S): MindState {
  return { mood, person: person.id, lastSeen: { x: person.x, y: person.y }, chaseLeftS };
}

/** Someone it is touching needs no line of sight: at a door jamb or a portal there may be none, and it would bump them. */
function canSee(ball: Ball, person: Person): boolean {
  const tiles = distance(ball, person);
  return tiles <= BALL_STOP_TILES || (person.inSight && tiles <= BALL_SEES_TILES);
}

function visiblePerson(ball: Ball, people: readonly Person[], id: string): Person | null {
  const person = people.find((p) => p.id === id);
  return person && canSee(ball, person) ? person : null;
}

function nearestSeen(mind: BallMind, ball: Ball, people: readonly Person[]): Person | null {
  let nearest: Person | null = null;
  for (const person of people) {
    const closer = nearest === null || distance(ball, person) < distance(ball, nearest);
    if (closer && !mind.ignored.has(person.id) && canSee(ball, person)) {
      nearest = person;
    }
  }
  return nearest;
}

function distance(a: Spot, b: Spot): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Heads for the spot, sliding along any wall in the way instead of running into it: each tick against a wall would be
 * a bounce, and a tap of sound. Returns whether the walls leave it enough headway.
 */
function steer(map: GameMap, ball: Ball, to: Spot, dt: number): boolean {
  const dx = to.x - ball.x;
  const dy = to.y - ball.y;
  const tiles = Math.hypot(dx, dy);
  ball.vx = (dx / tiles) * BALL_OWN_SPEED;
  ball.vy = (dy / tiles) * BALL_OWN_SPEED;
  const nextX = ball.x + ball.vx * dt;
  if (ballBlockedAt(map, nextX, ball.y)) {
    ball.vx = 0;
    ball.vy = slideSpeed(dy, dt, (offset) => !ballBlockedAt(map, nextX, ball.y + offset));
  } else if (ballBlockedAt(map, nextX, ball.y + ball.vy * dt)) {
    const nextY = ball.y + ball.vy * dt;
    ball.vy = 0;
    ball.vx = slideSpeed(dx, dt, (offset) => !ballBlockedAt(map, ball.x + offset, nextY));
  }
  return Math.hypot(ball.vx, ball.vy) >= HEADWAY_SPEED;
}

/**
 * Along a wall: towards the near way round its corner if there is one, as a ball clipping a door jamb must move away
 * from a spot in line with the jamb. Otherwise towards the spot, just far enough to come into line with it.
 */
function slideSpeed(tilesToSpot: number, dt: number, isClear: (offset: number) => boolean): number {
  for (let offset = CORNER_PROBE_TILES; offset <= CORNER_SEARCH_TILES; offset += CORNER_PROBE_TILES) {
    const towardsSpot = isClear(Math.sign(tilesToSpot) * offset);
    if (towardsSpot || isClear(-Math.sign(tilesToSpot) * offset)) {
      const direction = towardsSpot ? Math.sign(tilesToSpot) : -Math.sign(tilesToSpot);
      return direction * Math.min(offset / dt, BALL_OWN_SPEED);
    }
  }
  return Math.sign(tilesToSpot) * Math.min(Math.abs(tilesToSpot) / dt, BALL_OWN_SPEED);
}

/** At its own speed, friction takes it a tile: out of the doorway it came through, or it would rest tucked in there. */
function rollOn(ball: Ball): void {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > 0 && speed < BALL_OWN_SPEED) {
    ball.vx = (ball.vx / speed) * BALL_OWN_SPEED;
    ball.vy = (ball.vy / speed) * BALL_OWN_SPEED;
  }
}

function stop(ball: Ball): void {
  ball.vx = 0;
  ball.vy = 0;
}

function voice(mind: BallMind, cry: BallCry, rng: () => number): BallCryChoice {
  const variant = pickCryVariant(BALL_CRIES[cry].length, mind.lastVariants.get(cry), rng);
  mind.lastVariants.set(cry, variant);
  mind.cooldownLeftS = BALL_CRY_COOLDOWN_S;
  return { cry, variant };
}

/** Any of `count` sounds but the last one played, so an emotion never repeats itself. */
export function pickCryVariant(count: number, last: number | undefined, rng: () => number): number {
  if (last === undefined || count < 2) {
    return Math.floor(rng() * count);
  }
  const variant = Math.floor(rng() * (count - 1));
  return variant >= last ? variant + 1 : variant;
}
