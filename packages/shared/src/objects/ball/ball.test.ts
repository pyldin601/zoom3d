import { describe, expect, test } from 'vitest';
import { isWallAt, parseMap } from '../../map/map';
import { twoDoorways } from '../../portals/test-doorways';
import { defined } from '../vacuum/test-helpers';
import {
  BALL_KICK_REACH,
  BALL_MAX_SPEED,
  BALL_PUSH_MAX_SPEED,
  BALL_RADIUS,
  type Ball,
  type BallBody,
  ballInfo,
  createBall,
  kickBall,
  restoreBall,
  saveBall,
  stepBall,
} from './ball';

// Ball spec §2: a floor-bound ball with rolling friction, bouncing off walls, people and the vacuum.
const DT = 1 / 60;

/** A long corridor for rolling distances. */
const CORRIDOR = parseMap(
  [
    '11111111111111111111111111',
    '1S.......................1',
    '1........................1',
    '11111111111111111111111111',
  ].join('\n')
);

/** A room with a one-tile wall column at x = 5, rows 1–3. */
const ROOM = parseMap(
  ['111111111111', '1....1.....1', '1....1.....1', '1....1.....1', '1..........1', '1.........S1', '111111111111'].join(
    '\n'
  )
);

const moving = (x: number, y: number, vx: number, vy: number): Ball => ({ ...createBall('b', x, y), vx, vy });

const person = (x: number, y: number, vx = 0, vy = 0): BallBody => ({ kind: 'person', x, y, vx, vy, radius: 0.25 });
const vacuum = (x: number, y: number, vx = 0, vy = 0): BallBody => ({ kind: 'vacuum', x, y, vx, vy, radius: 0.35 });

const speed = (b: Ball) => Math.hypot(b.vx, b.vy);

/** Steps until the ball's x velocity turns negative: that step's event and the x velocity just before it. */
function stepUntilBack(ball: Ball): { event: string | null; before: number } {
  for (let i = 0; i < 600; i++) {
    const before = ball.vx;
    const event = stepBall(ROOM, ball, DT, []);
    if (ball.vx < 0) {
      return { event, before };
    }
  }
  throw new Error('it never came back');
}

describe('rolling', () => {
  test('friction stops a kicked ball after about v²/2a', () => {
    const ball = createBall('b', 2, 2);
    kickBall(ball, { x: 1.5, y: 2 }, 0);
    for (let i = 0; i < 60 * 10; i++) {
      stepBall(CORRIDOR, ball, DT, []);
    }
    expect(ball.x - 2).toBeGreaterThan(15);
    expect(ball.x - 2).toBeLessThan(16.5);
    expect(ball.vx).toBe(0);
    expect(ball.vy).toBe(0);
  });

  test('it comes to exact rest', () => {
    const ball = moving(3, 2, 0.04, 0);
    stepBall(CORRIDOR, ball, DT, []);
    expect(ball.vx).toBe(0);
    expect(ball.vy).toBe(0);
  });

  test('a long step does not tunnel through a one-tile wall', () => {
    const ball = moving(3.5, 2.5, 8, 0);
    stepBall(ROOM, ball, 1, []);
    expect(ball.x).toBeLessThan(5);
  });

  test('its heading follows its travel and is kept once it stops', () => {
    const ball = moving(3, 4.5, 0, 0.5);
    stepBall(ROOM, ball, DT, []);
    expect(ball.heading).toBeCloseTo(Math.PI / 2);
    for (let i = 0; i < 60; i++) {
      stepBall(ROOM, ball, DT, []);
    }
    expect(speed(ball)).toBe(0);
    expect(ball.heading).toBeCloseTo(Math.PI / 2);
    expect(ballInfo(ball)).toEqual({ id: 'b', kind: 'ball', x: ball.x, y: ball.y, angle: ball.heading, vx: 0, vy: 0 });
  });
});

describe('kicks', () => {
  test('a kick sends it at kick speed along the angle', () => {
    const ball = createBall('b', 3, 3);
    expect(kickBall(ball, { x: 3, y: 2.5 }, Math.PI / 2)).toBe(true);
    expect(ball.vx).toBeCloseTo(0);
    expect(ball.vy).toBeCloseTo(8);
  });

  test('a kick out of reach does nothing', () => {
    const ball = createBall('b', 3, 3);
    expect(kickBall(ball, { x: 3 - BALL_KICK_REACH - 0.01, y: 3 }, 0)).toBe(false);
    expect(speed(ball)).toBe(0);
  });

  test('slack widens the reach', () => {
    const ball = createBall('b', 3, 3);
    expect(kickBall(ball, { x: 3 - BALL_KICK_REACH - 0.4, y: 3 }, 0, 0.5)).toBe(true);
  });
});

describe('walls', () => {
  test('a wall reflects the normal part with 0.6 restitution, on x', () => {
    const ball = moving(3.5, 2.5, 4, 0);
    const { event, before } = stepUntilBack(ball);
    expect(event).toBe('bounce');
    expect(ball.vx).toBeCloseTo(-0.6 * before, 1);
    expect(ball.vy).toBe(0);
  });

  test('a wall reflects the normal part with 0.6 restitution, on y', () => {
    const ball = moving(8.5, 3.5, 0, -4);
    let before = ball.vy;
    for (let i = 0; i < 600 && ball.vy < 0; i++) {
      before = ball.vy;
      stepBall(ROOM, ball, DT, []);
    }
    expect(ball.vy).toBeCloseTo(-0.6 * before, 1);
    expect(ball.vx).toBe(0);
  });

  test('a slow hit makes no sound', () => {
    const ball = moving(4.7, 2.5, 0.8, 0);
    expect(stepUntilBack(ball).event).toBeNull();
    expect(ball.vx).toBeLessThan(0);
  });

  test('pinned against a wall by a walker it stays out of the wall', () => {
    const ball = createBall('b', 4, 2.5);
    const walker = person(3.6, 2.5, 3, 0);
    for (let i = 0; i < 60; i++) {
      walker.x = Math.min(walker.x + walker.vx * DT, 5 - 0.25);
      stepBall(ROOM, ball, DT, [walker]);
      expect(isWallAt(ROOM, ball.x + BALL_RADIUS, ball.y)).toBe(false);
      expect(Number.isFinite(ball.x)).toBe(true);
    }
  });
});

describe('bodies', () => {
  test('a walker pushes it ahead', () => {
    const ball = createBall('b', 3, 4.5);
    const walker = person(2.6, 4.5, 3, 0);
    stepBall(ROOM, ball, DT, [walker]);
    expect(ball.vx).toBeGreaterThanOrEqual(3.6 - 0.05);
    expect(Math.hypot(ball.x - walker.x, ball.y - walker.y)).toBeGreaterThanOrEqual(0.45 - 1e-6);
  });

  test('a standing person bounces it with 0.4 restitution', () => {
    const ball = moving(4.5, 4.5, 4, 0);
    const event = stepBall(ROOM, ball, DT, [person(4.9, 4.5)]);
    expect(event).toBe('bounce');
    expect(ball.vx).toBeCloseTo(-1.6, 1);
  });

  test('a driving vacuum kicks it', () => {
    const ball = createBall('b', 5.1, 4.5);
    expect(stepBall(ROOM, ball, DT, [vacuum(4.6, 4.5, 0.6, 0)])).toBe('kick');
    expect(ball.vx).toBeGreaterThanOrEqual(2.5 - 0.05);
  });

  test('a still vacuum bounces it like a person', () => {
    const ball = moving(4.5, 4.5, 3, 0);
    expect(stepBall(ROOM, ball, DT, [vacuum(5.0, 4.5)])).toBe('bounce');
    expect(ball.vx).toBeCloseTo(-1.2, 1);
  });

  test('squeezed from both sides it stays finite and capped', () => {
    const ball = createBall('b', 5, 4.5);
    const left = person(4.75, 4.5, 3, 0);
    const right = person(5.25, 4.5, -3, 0);
    for (let i = 0; i < 10; i++) {
      stepBall(ROOM, ball, DT, [left, right]);
      expect(Number.isFinite(ball.x) && Number.isFinite(ball.y)).toBe(true);
      expect(speed(ball)).toBeLessThanOrEqual(BALL_MAX_SPEED);
    }
  });

  test("a body on its centre pushes it along the body's velocity", () => {
    const ball = createBall('b', 3, 4.5);
    stepBall(ROOM, ball, DT, [person(3, 4.5, 0, 2)]);
    expect(ball.y).toBeGreaterThan(4.5);
    expect(ball.vy).toBeGreaterThan(0);
  });

  test('a still body on its centre pushes it along +x', () => {
    const ball = createBall('b', 3, 4.5);
    stepBall(ROOM, ball, DT, [person(3, 4.5)]);
    expect(ball.x).toBeGreaterThan(3);
    expect(Number.isFinite(ball.vx)).toBe(true);
  });
});

describe('restart survival', () => {
  test('save and restore round trip, at rest under a new id', () => {
    const ball = moving(3.25, 4.75, 2, 1);
    const restored = defined(restoreBall(ROOM, saveBall(ROOM, ball), 'b2'));
    expect(restored).toMatchObject({ id: 'b2', x: 3.25, y: 4.75, vx: 0, vy: 0 });
  });

  test("another map's save reads as null", () => {
    expect(restoreBall(CORRIDOR, saveBall(ROOM, createBall('b', 3, 2)), 'b2')).toBeNull();
  });

  test('a save inside a wall reads as null', () => {
    expect(restoreBall(ROOM, { ...saveBall(ROOM, createBall('b', 3, 2)), x: 5.5, y: 1.5 }, 'b2')).toBeNull();
  });
});

describe('implausible bodies (review: bunched poses)', () => {
  test('a body reported at 200 tiles/s neither launches it nor sends it through a wall', () => {
    const ball = createBall('b', 4.6, 2.5);
    stepBall(ROOM, ball, DT, [person(4.2, 2.5, 200, 0)]);
    expect(ball.x).toBeLessThan(5);
    expect(speed(ball)).toBeLessThanOrEqual(BALL_MAX_SPEED);
  });

  test('a body reported at 50 tiles/s pushes no harder than a fast walker', () => {
    const ball = createBall('b', 3, 4.5);
    stepBall(ROOM, ball, DT, [person(2.6, 4.5, 50, 0)]);
    expect(ball.vx).toBeLessThanOrEqual(BALL_PUSH_MAX_SPEED);
  });
});

describe('through portals', () => {
  const { map, portals } = twoDoorways();

  test('a ball rolling south through A comes out of B rolling north', () => {
    const ball = { ...createBall('b', 2.5, 3.2), vy: 3, heading: Math.PI / 2 };
    for (let i = 0; i < 20; i++) {
      stepBall(map, ball, DT, [], portals);
    }
    expect(ball.x).toBeCloseTo(4.5);
    expect(ball.y).toBeLessThan(3.5);
    expect(ball.vy).toBeLessThan(0);
    expect(ball.vx).toBeCloseTo(0);
    expect(ball.heading).toBeCloseTo(-Math.PI / 2);
  });

  test('a ball shoved across A by a body comes out of B', () => {
    const ball = createBall('b', 2.5, 3.45);
    stepBall(map, ball, DT, [person(2.5, 3.2, 0, 2)], portals);
    expect(ball.x).toBeCloseTo(4.5);
    expect(ball.y).toBeLessThan(3.5);
  });

  test('the same roll without portals stays on the south side', () => {
    const ball = { ...createBall('b', 2.5, 3.2), vy: 3, heading: Math.PI / 2 };
    for (let i = 0; i < 20; i++) {
      stepBall(map, ball, DT, [], null);
    }
    expect(ball.x).toBeCloseTo(2.5);
    expect(ball.y).toBeGreaterThan(3.5);
  });
});
