// The ball's personality, a curious puppy (living ball spec §2): a state machine the server runs before the physics.
// It only ever sets a velocity at or below its own speed, and only once a kick, push or bounce has played out, so it
// can't get in the way of the ball being a ball.
import { hasLineOfSight } from '../../geometry/los';
import { PLAYER_RADIUS } from '../../geometry/movement';
import type { GameMap } from '../../map/map';
import type { BallCry, BallMood } from '../../protocol/protocol';
import { BALL_RADIUS, type Ball, type BallTouch } from './ball';
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
const WANDER_PAUSE_MIN_S = 1;
const WANDER_PAUSE_MAX_S = 4;
/** Its own steering can round to just above its own speed, and mustn't count as being pushed. */
const SPEED_ROUNDING = 1e-6;
/** This close to a spot counts as there. */
const ARRIVED_TILES = 0.2;

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
}

export interface BallCryChoice {
  cry: BallCry;
  variant: number;
}

type Person = BallSenses['people'][number];

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
  passTime(mind, ball, dt, senses.people);
  const cry = reactToTouch(map, mind, ball, senses, say);
  if (mind.state.mood === 'asleep') {
    return cry ?? sleep(map, mind, ball, dt, senses.people, rng, say);
  }
  if (Math.hypot(ball.vx, ball.vy) > BALL_OWN_SPEED + SPEED_ROUNDING) {
    return cry;
  }
  return cry ?? behave(map, mind, ball, dt, senses.people, rng, say);
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
  map: GameMap,
  mind: BallMind,
  ball: Ball,
  { people, touch }: BallSenses,
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
    const person = nearestSeen(map, mind, ball, people);
    if (person) {
      // A crossing doesn't reset a chase of the same person, or doorways could keep it going for ever.
      const sameChase = (state.mood === 'approaching' || state.mood === 'following') && state.person === person.id;
      mind.state = chase('approaching', person, sameChase ? state.chaseLeftS : CHASE_S);
      cry = say('yip');
    } else {
      mind.state = { mood: 'scared', secondsLeft: SCARED_S };
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
  map: GameMap,
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
  if (state.lost && nearestSeen(map, mind, ball, people) === null) {
    mind.state = { mood: 'scared', secondsLeft: SCARED_S };
    return say('whimper');
  }
  mind.state = paused(rng);
  return say('yawn');
}

function behave(
  map: GameMap,
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
      const person = nearestSeen(map, mind, ball, people);
      if (person) {
        mind.state = chase('approaching', person);
        return say('happy');
      }
      wander(map, mind, ball, dt, rng);
      return null;
    }
    case 'scared': {
      stop(ball);
      const person = nearestSeen(map, mind, ball, people);
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
      const person = visiblePerson(map, ball, people, state.person);
      if (person) {
        state.lastSeen = { x: person.x, y: person.y };
      }
      if (!person || distance(ball, person) > PLAY_LEAVE_TILES) {
        mind.state = { mood: 'following', person: state.person, lastSeen: state.lastSeen, chaseLeftS: CHASE_S };
        return null;
      }
      play(map, state, ball, person, dt, rng);
      return null;
    }
    case 'approaching':
    case 'following': {
      state.chaseLeftS -= dt;
      const person = visiblePerson(map, ball, people, state.person);
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
      if (state.chaseLeftS <= 0) {
        stop(ball);
        mind.ignored.set(state.person, { secondsLeft: IGNORE_S, beenAway: false });
        mind.state = paused(rng);
        return say('sad');
      }
      if (distance(ball, state.lastSeen) > ARRIVED_TILES) {
        steer(ball, state.lastSeen);
      } else {
        stop(ball);
      }
      return null;
    }
  }
}

function play(
  map: GameMap,
  state: Extract<MindState, { mood: 'playing' }>,
  ball: Ball,
  person: Person,
  dt: number,
  rng: () => number
): void {
  state.secondsLeft -= dt;
  if (state.dash === null) {
    if (state.secondsLeft <= 0) {
      state.dash = playSpot(map, ball, person, rng);
      state.secondsLeft = state.dash ? PLAY_DASH_S : playRestS(rng);
    }
    return;
  }
  if (state.secondsLeft <= 0 || distance(ball, state.dash) <= ARRIVED_TILES) {
    stop(ball);
    state.dash = null;
    state.secondsLeft = playRestS(rng);
    return;
  }
  steer(ball, state.dash);
}

function playSpot(map: GameMap, ball: Ball, person: Person, rng: () => number): Spot | null {
  const side = rng() < 0.5 ? -1 : 1;
  const swing = PLAY_SWING_MIN_RADIANS + rng() * (PLAY_SWING_MAX_RADIANS - PLAY_SWING_MIN_RADIANS);
  const angle = Math.atan2(ball.y - person.y, ball.x - person.x) + side * swing;
  const tiles = PLAY_MIN_TILES + rng() * (PLAY_MAX_TILES - PLAY_MIN_TILES);
  const x = person.x + Math.cos(angle) * tiles;
  const y = person.y + Math.sin(angle) * tiles;
  return hasLineOfSight(map, ball.x, ball.y, x, y) ? { x, y } : null;
}

function playRestS(rng: () => number): number {
  return PLAY_REST_MIN_S + rng() * (PLAY_REST_MAX_S - PLAY_REST_MIN_S);
}

function wander(map: GameMap, mind: BallMind, ball: Ball, dt: number, rng: () => number): void {
  const { state } = mind;
  if (state.mood !== 'wandering') {
    return;
  }
  state.secondsLeft -= dt;
  if (state.target === null) {
    // A pause leaves the ball to its friction: a slow roll carries on and comes to rest by itself.
    if (state.secondsLeft <= 0) {
      const target = wanderSpot(map, ball, rng);
      mind.state = target ? { mood: 'wandering', target, secondsLeft: WANDER_TARGET_S } : paused(rng);
    }
    return;
  }
  if (state.secondsLeft <= 0 || distance(ball, state.target) <= ARRIVED_TILES) {
    stop(ball);
    mind.state = paused(rng);
    return;
  }
  steer(ball, state.target);
}

function wanderSpot(map: GameMap, ball: Ball, rng: () => number): Spot | null {
  const angle = rng() * Math.PI * 2;
  const tiles = WANDER_MIN_TILES + rng() * (WANDER_MAX_TILES - WANDER_MIN_TILES);
  const x = ball.x + Math.cos(angle) * tiles;
  const y = ball.y + Math.sin(angle) * tiles;
  return hasLineOfSight(map, ball.x, ball.y, x, y) ? { x, y } : null;
}

function paused(rng: () => number): MindState {
  const pauseS = WANDER_PAUSE_MIN_S + rng() * (WANDER_PAUSE_MAX_S - WANDER_PAUSE_MIN_S);
  return { mood: 'wandering', target: null, secondsLeft: pauseS };
}

function chase(mood: 'approaching', person: Person, chaseLeftS = CHASE_S): MindState {
  return { mood, person: person.id, lastSeen: { x: person.x, y: person.y }, chaseLeftS };
}

function canSee(map: GameMap, ball: Ball, person: Person): boolean {
  return distance(ball, person) <= BALL_SEES_TILES && hasLineOfSight(map, ball.x, ball.y, person.x, person.y);
}

function visiblePerson(map: GameMap, ball: Ball, people: readonly Person[], id: string): Person | null {
  const person = people.find((p) => p.id === id);
  return person && canSee(map, ball, person) ? person : null;
}

function nearestSeen(map: GameMap, mind: BallMind, ball: Ball, people: readonly Person[]): Person | null {
  let nearest: Person | null = null;
  for (const person of people) {
    const closer = nearest === null || distance(ball, person) < distance(ball, nearest);
    if (closer && !mind.ignored.has(person.id) && canSee(map, ball, person)) {
      nearest = person;
    }
  }
  return nearest;
}

function distance(a: Spot, b: Spot): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function steer(ball: Ball, to: Spot): void {
  const tiles = distance(ball, to);
  ball.vx = ((to.x - ball.x) / tiles) * BALL_OWN_SPEED;
  ball.vy = ((to.y - ball.y) / tiles) * BALL_OWN_SPEED;
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
