import { beforeEach, describe, expect, test } from 'vitest';
import { PLAYER_RADIUS } from '../../geometry/movement';
import { parseMap } from '../../map/map';
import { BALL_KICK_REACH, BALL_RADIUS, type Ball, type BallTouch, createBall, stepBall } from './ball';
import { BALL_CRIES } from './cries';
import {
  BALL_CRY_COOLDOWN_S,
  BALL_OWN_SPEED,
  BALL_SEES_TILES,
  BALL_STOP_TILES,
  BALL_WAKE_S,
  type BallCryChoice,
  type BallMind,
  createBallMind,
  kickBallMind,
  pickCryVariant,
  stepBallMind,
} from './mind';

// Living ball spec §2: the puppy's states, its senses, and physics coming first.
const DT = 1 / 15;
const TOUCHING = PLAYER_RADIUS + BALL_RADIUS;
/** It follows beyond a tile past touching, and a tick's roll can carry it a little further first. */
const PLAY_LIMIT = TOUCHING + 1.2;

/** An open room with one wall column at x = 25, rows 10 to 20. */
const ROOM = parseMap(
  Array.from({ length: 31 }, (_, y) =>
    Array.from({ length: 41 }, (_, x) => {
      if (x === 0 || y === 0 || x === 40 || y === 30 || (x === 25 && y >= 10 && y <= 20)) {
        return '1';
      }
      return x === 1 && y === 1 ? 'S' : '.';
    }).join('')
  ).join('\n')
);

interface Person {
  id: string;
  x: number;
  y: number;
}

let mind: BallMind;
let ball: Ball;
let people: Person[];
let touch: BallTouch;
let cries: BallCryChoice[];
let seed: number;
const rng = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

beforeEach(() => {
  mind = createBallMind();
  ball = createBall('b', 10, 15);
  people = [];
  touch = { pushed: false, knocked: false, crossedPortal: false };
  cries = [];
  seed = 12345;
});

const said = () => cries.map((c) => c.cry);

/** One tick: the mind, then the physics, as the server runs them. */
function tick(): void {
  const cry = stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
  if (cry) {
    cries.push(cry);
  }
  touch.pushed = false;
  touch.knocked = false;
  touch.crossedPortal = false;
  stepBall(ROOM, ball, DT, []);
}

function run(seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    tick();
  }
}

const distanceTo = (p: Person) => Math.hypot(ball.x - p.x, ball.y - p.y);

/** Puts a person `tiles` east of the ball. */
function personBeside(tiles: number, id = 'a'): Person {
  const p = { id, x: ball.x + tiles, y: ball.y };
  people.push(p);
  return p;
}

/** Waits until any cry could play again. */
const calm = () => run(BALL_CRY_COOLDOWN_S + 0.1);

function wake(): void {
  run(BALL_WAKE_S + 0.1);
  expect(mind.mood).toBe('wandering');
}

function approaching(tiles = 4): Person {
  wake();
  const p = personBeside(tiles);
  tick();
  expect(mind.mood).toBe('approaching');
  return p;
}

function playing(): Person {
  const p = approaching(2);
  run(3);
  expect(mind.mood).toBe('playing');
  return p;
}

function following(): Person {
  const p = playing();
  p.x += 3;
  tick();
  expect(mind.mood).toBe('following');
  return p;
}

function scared(): void {
  wake();
  people = [];
  touch.crossedPortal = true;
  tick();
  expect(mind.mood).toBe('scared');
}

const states: readonly [string, () => void][] = [
  ['wandering', wake],
  ['approaching', approaching],
  ['playing', playing],
  ['following', following],
  ['scared', scared],
];

describe('sleep', () => {
  test('a new mind sleeps, and wakes wandering with a yawn after 10 s', () => {
    expect(BALL_WAKE_S).toBe(10);
    expect(mind.mood).toBe('asleep');
    run(9.9);
    expect(mind.mood).toBe('asleep');
    expect(cries).toEqual([]);
    run(0.2);
    expect(mind.mood).toBe('wandering');
    expect(said()).toEqual(['yawn']);
  });

  test('pushes do not move the wake-up', () => {
    run(5);
    touch.pushed = true;
    tick();
    run(4.8);
    expect(mind.mood).toBe('asleep');
    run(0.3);
    expect(mind.mood).toBe('wandering');
  });

  test('a kick while asleep restarts its 10 s with no cry', () => {
    run(9);
    expect(kickBallMind(mind, rng)).toBeNull();
    run(9);
    expect(mind.mood).toBe('asleep');
    run(1.1);
    expect(mind.mood).toBe('wandering');
  });

  test.each(states)('a kick while %s sleeps it with a yelp and writes no velocity', (_name, enter) => {
    enter();
    Object.assign(ball, { vx: 0.5, vy: 0.25 });
    const choice = kickBallMind(mind, rng);
    expect(choice?.cry).toBe('yelp');
    expect(mind.mood).toBe('asleep');
    expect(ball.vx).toBe(0.5);
    expect(ball.vy).toBe(0.25);
  });

  test('nothing steers a sleeping ball', () => {
    personBeside(2);
    for (let i = 0; i < 30; i++) {
      tick();
      expect(ball.vx).toBe(0);
      expect(ball.vy).toBe(0);
    }
  });
});

describe('crossing a portal', () => {
  test('asleep and alone: silent until it wakes scared', () => {
    touch.crossedPortal = true;
    tick();
    expect(mind.mood).toBe('asleep');
    expect(cries).toEqual([]);
    run(BALL_WAKE_S);
    expect(mind.mood).toBe('scared');
    expect(said()).toEqual(['whimper']);
  });

  test('asleep, and someone there on waking: wakes as usual', () => {
    touch.crossedPortal = true;
    tick();
    personBeside(3);
    while (mind.mood === 'asleep') {
      tick();
    }
    expect(said()).toEqual(['yawn']);
    expect(mind.mood).toBe('wandering');
  });

  test('another kick on a lost, sleeping ball leaves it lost', () => {
    touch.crossedPortal = true;
    tick();
    kickBallMind(mind, rng);
    run(BALL_WAKE_S + 0.1);
    expect(mind.mood).toBe('scared');
  });

  test('a kick after being lost and awake starts a fresh sleep', () => {
    scared();
    run(6.1);
    kickBallMind(mind, rng);
    run(BALL_WAKE_S + 0.1);
    expect(mind.mood).toBe('wandering');
  });

  test('awake and alone: scared, with a whimper', () => {
    wake();
    calm();
    touch.crossedPortal = true;
    tick();
    expect(mind.mood).toBe('scared');
    expect(said().at(-1)).toBe('whimper');
  });

  test('awake with someone in sight: approaches them with a yip', () => {
    playing();
    calm();
    touch.crossedPortal = true;
    tick();
    expect(mind.mood).toBe('approaching');
    expect(said().at(-1)).toBe('yip');
  });

  test('crossing while chasing the same person does not restart the chase', () => {
    const p = approaching(3);
    const keepAway = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        p.x = ball.x + 3;
        p.y = ball.y;
        tick();
      }
    };
    keepAway(4);
    touch.crossedPortal = true;
    keepAway(1.8);
    expect(mind.mood).toBe('approaching');
    keepAway(0.4);
    expect(mind.mood).toBe('wandering');
  });

  test('crossing towards someone new starts a full chase', () => {
    const p = approaching(3);
    for (let i = 0; i < Math.round(4 / DT); i++) {
      p.x = ball.x + 3;
      p.y = ball.y;
      tick();
    }
    people = [{ id: 'b', x: ball.x + 3, y: ball.y }];
    touch.crossedPortal = true;
    for (let i = 0; i < Math.round(4 / DT); i++) {
      const other = people.at(0);
      if (other) {
        other.x = ball.x + 3;
        other.y = ball.y;
      }
      tick();
    }
    expect(['approaching', 'following']).toContain(mind.mood);
  });

  test('crossing again while scared restarts its 6 s', () => {
    scared();
    run(5);
    touch.crossedPortal = true;
    tick();
    run(5);
    expect(mind.mood).toBe('scared');
    run(1.1);
    expect(mind.mood).toBe('wandering');
  });
});

describe('seeing people', () => {
  test('sees someone 6 tiles off, and not 6.5', () => {
    expect(BALL_SEES_TILES).toBe(6);
    wake();
    ball.x = 10;
    ball.y = 15;
    Object.assign(ball, { vx: 0, vy: 0 });
    const p = personBeside(6.5);
    stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
    expect(mind.mood).toBe('wandering');
    p.x = ball.x + 5.9;
    stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
    expect(mind.mood).toBe('approaching');
  });

  test('does not see through a wall', () => {
    wake();
    Object.assign(ball, { x: 23.5, y: 15, vx: 0, vy: 0 });
    people.push({ id: 'a', x: 27.5, y: 15 });
    stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
    expect(mind.mood).toBe('wandering');
  });

  test('chooses the nearest', () => {
    wake();
    const far = personBeside(5, 'far');
    const near = personBeside(2, 'near');
    run(3);
    expect(mind.mood).toBe('playing');
    expect(distanceTo(near)).toBeLessThan(distanceTo(far));
  });

  test('stays with its first person when a second comes nearer', () => {
    const first = approaching(5);
    const second = personBeside(-1.5, 'second');
    run(6);
    expect(mind.mood).toBe('playing');
    second.x = first.x + 1;
    second.y = first.y + 1;
    for (let i = 0; i < 90; i++) {
      tick();
      expect(distanceTo(first)).toBeLessThanOrEqual(PLAY_LIMIT);
    }
  });
});

describe('going to someone', () => {
  test('stops at its stopping distance, not touching and within kick reach', () => {
    expect(BALL_STOP_TILES).toBeGreaterThan(TOUCHING);
    expect(BALL_STOP_TILES).toBeLessThan(BALL_KICK_REACH);
    const p = approaching(2);
    while (mind.mood === 'approaching') {
      tick();
    }
    expect(mind.mood).toBe('playing');
    expect(ball.vx).toBe(0);
    expect(ball.vy).toBe(0);
    expect(distanceTo(p)).toBeGreaterThan(TOUCHING);
    expect(distanceTo(p)).toBeLessThanOrEqual(BALL_KICK_REACH);
  });

  test('steers at its own speed, no faster', () => {
    approaching(5);
    for (let i = 0; i < 30; i++) {
      stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
      expect(Math.hypot(ball.vx, ball.vy)).toBeLessThanOrEqual(BALL_OWN_SPEED + 1e-9);
      stepBall(ROOM, ball, DT, []);
    }
    expect(BALL_OWN_SPEED).toBe(2);
  });

  test('a happy chirp when it notices someone, if the cooldown has passed', () => {
    wake();
    calm();
    personBeside(3);
    tick();
    expect(said().at(-1)).toBe('happy');
  });

  test('playing holds within a tile of touching, and follows beyond it', () => {
    const p = playing();
    p.x = ball.x + TOUCHING + 0.9;
    p.y = ball.y;
    tick();
    expect(mind.mood).toBe('playing');
    p.x = ball.x + TOUCHING + 1.1;
    tick();
    expect(mind.mood).toBe('following');
  });

  test('playing follows when a wall comes between them', () => {
    wake();
    Object.assign(ball, { x: 24, y: 9.5, vx: 0, vy: 0 });
    const p = { id: 'a', x: 24.75, y: 9.5 };
    people.push(p);
    run(1);
    expect(mind.mood).toBe('playing');
    Object.assign(ball, { x: 24.8, y: 12 });
    Object.assign(p, { x: 26.1, y: 12 });
    tick();
    expect(mind.mood).toBe('following');
  });

  test('following turns back to playing on catching up, with a fresh chase', () => {
    const p = following();
    run(1);
    p.x = ball.x + 1.5;
    p.y = ball.y;
    run(2);
    expect(mind.mood).toBe('playing');
    for (let i = 0; i < Math.round(5.5 / DT); i++) {
      p.x = ball.x + 3;
      tick();
    }
    expect(mind.mood).toBe('following');
  });
});

describe('playing', () => {
  test('it dashes about its person, resting between dashes, on every side of them', () => {
    const p = playing();
    let dashing = 0;
    let resting = 0;
    const sides = new Set<number>();
    for (let i = 0; i < Math.round(30 / DT); i++) {
      tick();
      expect(mind.mood).toBe('playing');
      expect(distanceTo(p)).toBeGreaterThan(TOUCHING);
      expect(distanceTo(p)).toBeLessThanOrEqual(PLAY_LIMIT);
      if (ball.vx !== 0 || ball.vy !== 0) {
        dashing++;
      } else {
        resting++;
      }
      sides.add(Math.floor(((Math.atan2(ball.y - p.y, ball.x - p.x) + Math.PI) / (2 * Math.PI)) * 4));
    }
    expect(dashing).toBeGreaterThan(30);
    expect(resting).toBeGreaterThan(30);
    expect(sides.size).toBe(4);
  });

  test('its dashes are real moves, not a shake', () => {
    playing();
    let longest = 0;
    let from = { x: ball.x, y: ball.y };
    for (let i = 0; i < Math.round(30 / DT); i++) {
      tick();
      if (ball.vx === 0 && ball.vy === 0) {
        longest = Math.max(longest, Math.hypot(ball.x - from.x, ball.y - from.y));
        from = { x: ball.x, y: ball.y };
      }
    }
    expect(longest).toBeGreaterThan(0.5);
  });

  test('never faster than its own speed', () => {
    playing();
    for (let i = 0; i < 300; i++) {
      stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
      expect(Math.hypot(ball.vx, ball.vy)).toBeLessThanOrEqual(BALL_OWN_SPEED + 1e-9);
      stepBall(ROOM, ball, DT, []);
    }
  });

  test('a spot behind a wall is not one it heads for', () => {
    wake();
    Object.assign(ball, { x: 24.3, y: 15, vx: 0, vy: 0 });
    people.push({ id: 'a', x: 23.6, y: 15 });
    for (let i = 0; i < Math.round(20 / DT); i++) {
      tick();
      expect(ball.x).toBeLessThan(25);
    }
  });
});

describe('giving up', () => {
  /** Someone walking away at a walk, so the ball never catches them. */
  const walkAway = (p: Person, seconds: number) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      p.x = ball.x + 3;
      p.y = ball.y;
      tick();
    }
  };

  test('a chase ends at 6 s in total with a sad note', () => {
    const p = approaching(3);
    walkAway(p, 5.8);
    expect(mind.mood).toBe('approaching');
    expect(said()).not.toContain('sad');
    walkAway(p, 0.3);
    expect(mind.mood).toBe('wandering');
    expect(said().at(-1)).toBe('sad');
  });

  test('losing sight of them does not restart the chase', () => {
    const p = approaching(3);
    walkAway(p, 3);
    people = [];
    tick();
    expect(mind.mood).toBe('following');
    people = [p];
    walkAway(p, 3);
    expect(mind.mood).toBe('wandering');
  });

  test('then ignores that person for 15 s', () => {
    const p = approaching(3);
    walkAway(p, 6.1);
    expect(mind.mood).toBe('wandering');
    walkAway(p, 14.5);
    expect(mind.mood).toBe('wandering');
    walkAway(p, 1);
    expect(mind.mood).toBe('approaching');
  });

  test('forgives them early within 2 tiles', () => {
    const p = approaching(3);
    walkAway(p, 6.1);
    p.x = ball.x + 1.9;
    p.y = ball.y;
    tick();
    expect(mind.mood).toBe('approaching');
  });

  test('someone it gave up on while close by is not forgiven at once, so it stops pushing', () => {
    wake();
    calm();
    // Close, and in sight, but it never gets there: something holds it back each tick.
    Object.assign(ball, { x: 10, y: 15, vx: 0, vy: 0 });
    people.push({ id: 'a', x: 11.5, y: 15 });
    let chasingTicks = 0;
    const ticks = Math.round(21 / DT);
    for (let i = 0; i < ticks; i++) {
      Object.assign(ball, { x: 10, y: 15 });
      const cry = stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
      if (cry) {
        cries.push(cry);
      }
      chasingTicks += mind.mood === 'approaching' || mind.mood === 'following' ? 1 : 0;
    }
    expect(said().filter((c) => c === 'sad')).toHaveLength(1);
    expect(chasingTicks * DT).toBeLessThan(12.5);
  });

  test('someone it gave up on from afar is forgiven only once they come close', () => {
    const p = approaching(3);
    walkAway(p, 6.1);
    expect(mind.mood).toBe('wandering');
    walkAway(p, 1);
    expect(mind.mood).toBe('wandering');
    p.x = ball.x + 1.9;
    p.y = ball.y;
    tick();
    expect(mind.mood).toBe('approaching');
  });

  test('someone else can be chosen straight away', () => {
    const p = approaching(3);
    walkAway(p, 6.1);
    expect(mind.mood).toBe('wandering');
    people.push({ id: 'b', x: ball.x, y: ball.y + 3 });
    p.x = ball.x + 3;
    tick();
    expect(mind.mood).toBe('approaching');
  });

  test('someone gone mid-chase is chased to their last seen spot, and given up on', () => {
    const p = approaching(4);
    const lastSeen = { x: p.x, y: p.y };
    people = [];
    run(0.1);
    expect(mind.mood).toBe('following');
    run(2);
    expect(Math.hypot(ball.x - lastSeen.x, ball.y - lastSeen.y)).toBeLessThan(4);
    run(4);
    expect(mind.mood).toBe('wandering');
    expect(said()).toContain('sad');
  });
});

describe('wandering', () => {
  test('it moves about and pauses', () => {
    wake();
    const from = { x: ball.x, y: ball.y };
    let moved = false;
    let rested = false;
    for (let i = 0; i < 300; i++) {
      tick();
      moved ||= Math.hypot(ball.vx, ball.vy) > 0;
      rested ||= moved && ball.vx === 0 && ball.vy === 0;
    }
    expect(moved).toBe(true);
    expect(rested).toBe(true);
    expect(Math.hypot(ball.x - from.x, ball.y - from.y)).toBeGreaterThan(0);
  });

  test('a spot it cannot reach is dropped within 5 s', () => {
    wake();
    let pushingFor = 0;
    let longest = 0;
    for (let i = 0; i < 900; i++) {
      // Whatever it heads for, it gets nowhere: a body holds it where it is.
      Object.assign(ball, { x: 10, y: 15 });
      const cry = stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
      expect(cry).toBeNull();
      pushingFor = Math.hypot(ball.vx, ball.vy) > 0 ? pushingFor + DT : 0;
      longest = Math.max(longest, pushingFor);
    }
    expect(longest).toBeGreaterThan(0);
    expect(longest).toBeLessThanOrEqual(5.1);
  });
});

describe('scared', () => {
  test('rests, then wanders after 6 s alone', () => {
    scared();
    run(5.9);
    expect(mind.mood).toBe('scared');
    expect(ball.vx).toBe(0);
    expect(ball.vy).toBe(0);
    run(0.2);
    expect(mind.mood).toBe('wandering');
  });

  test('seeing someone brings relief', () => {
    scared();
    calm();
    personBeside(3);
    tick();
    expect(mind.mood).toBe('approaching');
    expect(said().at(-1)).toBe('relieved');
  });
});

describe('physics comes first', () => {
  const rolling = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      Object.assign(ball, { x: 10, y: 15, vx: 3, vy: 0 });
      stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
      expect(ball.vx).toBe(3);
      expect(ball.vy).toBe(0);
    }
  };

  test.each(states)('rolling fast while %s, the mood holds and nothing steers', (name, enter) => {
    enter();
    const seen = mind.mood;
    rolling(20);
    expect(mind.mood).toBe(seen);
    expect(name).toBe(seen);
  });

  test('its sleep runs on regardless', () => {
    rolling(BALL_WAKE_S + 0.1);
    expect(mind.mood).toBe('wandering');
  });

  test('steering takes over once it has slowed to its own speed', () => {
    const p = approaching(5);
    Object.assign(ball, { vx: -BALL_OWN_SPEED, vy: 0 });
    stepBallMind(ROOM, mind, ball, DT, { people, touch }, rng);
    expect(ball.vx).toBeCloseTo(BALL_OWN_SPEED);
    expect(p.x).toBeGreaterThan(ball.x);
  });
});

describe('one-off sounds', () => {
  test('a stream of pushes gives one giggle, and another after 5 s of calm', () => {
    wake();
    calm();
    for (let i = 0; i < 300; i++) {
      Object.assign(ball, { vx: 3, vy: 0 });
      touch.pushed = true;
      tick();
    }
    expect(said().filter((c) => c === 'giggle')).toHaveLength(1);
    Object.assign(ball, { vx: 0, vy: 0 });
    run(5.1);
    touch.pushed = true;
    tick();
    expect(said().filter((c) => c === 'giggle')).toHaveLength(2);
  });

  test('a sleeping ball does not giggle', () => {
    touch.pushed = true;
    tick();
    expect(cries).toEqual([]);
  });

  test('a push does not change its mood', () => {
    playing();
    touch.pushed = true;
    tick();
    expect(mind.mood).toBe('playing');
  });

  test('a vacuum knock startles an awake ball and never sleeps it', () => {
    wake();
    calm();
    touch.knocked = true;
    tick();
    expect(said().at(-1)).toBe('startled');
    expect(mind.mood).toBe('wandering');
  });

  test('a sleeping ball does not startle', () => {
    touch.knocked = true;
    tick();
    expect(cries).toEqual([]);
    expect(mind.mood).toBe('asleep');
  });
});

describe('sound limits', () => {
  test('a change within the cooldown happens silently', () => {
    wake();
    personBeside(3);
    tick();
    expect(mind.mood).toBe('approaching');
    expect(said()).toEqual(['yawn']);
  });

  test('the yelp ignores the cooldown', () => {
    wake();
    expect(kickBallMind(mind, rng)?.cry).toBe('yelp');
  });

  test('a yelp starts the cooldown too', () => {
    wake();
    calm();
    kickBallMind(mind, rng);
    run(BALL_WAKE_S + 0.1);
    expect(said().at(-1)).toBe('yawn');
  });

  test('an emotion never plays the same sound twice in a row', () => {
    const variants: number[] = [];
    for (let i = 0; i < 40; i++) {
      wake();
      const choice = kickBallMind(mind, rng);
      variants.push(choice?.variant ?? -1);
    }
    expect(BALL_CRIES.yelp.length).toBeGreaterThan(1);
    for (let i = 1; i < variants.length; i++) {
      expect(variants.at(i)).not.toBe(variants.at(i - 1));
    }
    expect(Math.max(...variants)).toBeLessThan(BALL_CRIES.yelp.length);
    expect(Math.min(...variants)).toBeGreaterThanOrEqual(0);
  });

  test('pickCryVariant covers every sound and avoids the last', () => {
    expect(pickCryVariant(1, 0, rng)).toBe(0);
    const picked = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const v = pickCryVariant(5, 2, rng);
      expect(v).not.toBe(2);
      picked.add(v);
    }
    expect([...picked].sort()).toEqual([0, 1, 3, 4]);
    const first = new Set<number>();
    for (let i = 0; i < 200; i++) {
      first.add(pickCryVariant(3, undefined, rng));
    }
    expect(first.size).toBe(3);
  });
});
