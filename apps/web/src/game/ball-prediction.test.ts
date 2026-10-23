import { type BallBody, type ObjectInfo, type ObjectStateMessage, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createBallPrediction } from './ball-prediction';

// Ball spec §3.3: the local player's touches act at once; the server's ball is eased onto otherwise.
const DT = 1 / 60;
const MAP = parseMap(
  [
    '1111111111111',
    '1...........1',
    '1...........1',
    '1...........1',
    '1...........1',
    '1..........S1',
    '1111111111111',
  ].join('\n')
);
const info = (id: string, x: number, y: number): ObjectInfo => ({ id, kind: 'ball', x, y, angle: 0 });
const state = (x: number, y: number, extra: Partial<ObjectStateMessage> = {}): ObjectStateMessage => ({
  type: 'object_state',
  id: 'b',
  x,
  y,
  angle: 0,
  seq: 1,
  vx: 0,
  vy: 0,
  ...extra,
});
const walker = (x: number, y: number, vx: number): BallBody => ({ kind: 'person', x, y, vx, vy: 0, radius: 0.25 });

function predicted(x = 3, y = 3.5) {
  const p = createBallPrediction(MAP);
  p.reset(info('b', x, y));
  return p;
}
const ballOf = (p: ReturnType<typeof createBallPrediction>) => {
  if (!p.ball) {
    throw new Error('no ball');
  }
  return p.ball;
};

describe('holding the local touch', () => {
  test('a local push is not pulled back by stale server states for 300 ms', () => {
    const p = predicted();
    p.step(DT, 0, walker(2.6, 3.5, 3));
    const pushed = ballOf(p).x;
    expect(ballOf(p).vx).toBeGreaterThan(3);
    p.server(state(3, 3.5), 'me', 100);
    p.step(DT, 100, null);
    expect(ballOf(p).x).toBeGreaterThan(pushed);
    expect(ballOf(p).vx).toBeGreaterThan(0);
  });

  test('after the hold the server ball pulls it in', () => {
    const p = predicted();
    p.step(DT, 0, walker(2.6, 3.5, 3));
    const pushed = ballOf(p).x;
    p.server(state(3, 3.5), 'me', 400);
    p.step(DT, 400, null);
    expect(ballOf(p).x).toBeLessThan(pushed);
    expect(ballOf(p).vx).toBe(0);
  });

  test('the own kick echo ends the hold', () => {
    const p = predicted();
    const k = p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    expect(k).toBe(1);
    p.server(state(6, 3.5, { event: 'kick', by: 'me', k: 1 }), 'me', 50);
    p.step(0, 50, null);
    expect(ballOf(p).x).toBe(6);
  });

  test("someone else's kick does not end it", () => {
    const p = predicted();
    p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    p.server(state(6, 3.5, { event: 'kick', by: 'other', k: 1 }), 'me', 50);
    p.step(0, 50, null);
    expect(ballOf(p).x).toBe(3);
  });

  test('a kick out of reach does nothing and sends nothing', () => {
    const p = predicted();
    expect(p.kick({ x: 1.5, y: 3.5 }, 0, 0)).toBeNull();
    expect(ballOf(p).vx).toBe(0);
  });
});

describe('easing onto the server', () => {
  test('a 1-tile error shrinks to about 1/e in 100 ms', () => {
    const p = predicted(3, 3.5);
    p.server(state(4, 3.5), 'me', 0);
    for (let i = 0; i < 6; i++) {
      p.step(DT, i * DT * 1000, null);
    }
    expect(4 - ballOf(p).x).toBeGreaterThan(Math.exp(-1) * 0.85);
    expect(4 - ballOf(p).x).toBeLessThan(Math.exp(-1) * 1.15);
  });

  test('it snaps when the error is over 1.5 tiles', () => {
    const p = predicted(3, 3.5);
    p.server(state(5, 3.5), 'me', 0);
    p.step(DT, 0, null);
    expect(ballOf(p).x).toBe(5);
  });

  test('it snaps exactly when both are at rest within 0.05 tiles', () => {
    const p = predicted(3, 3.5);
    p.server(state(3.04, 3.5), 'me', 0);
    p.step(DT, 0, null);
    expect(ballOf(p).x).toBe(3.04);
  });

  test('a server state is advanced by 60 ms before comparing', () => {
    const p = predicted(8, 1.5);
    p.server(state(3, 3.5, { vx: 4 }), 'me', 0);
    p.step(0, 0, null);
    expect(ballOf(p).x).toBeCloseTo(3.24, 1);
  });
});

describe('welcomes', () => {
  test('a welcome with a new ball id replaces the old ball outright', () => {
    const p = predicted(3, 3.5);
    p.reset(info('c', 7, 2.5));
    expect(ballOf(p)).toMatchObject({ id: 'c', x: 7, y: 2.5 });
    p.server(state(3, 3.5), 'me', 0);
    p.step(DT, 0, null);
    expect(ballOf(p).x).toBe(7);
  });

  test('a welcome without a ball leaves none', () => {
    const p = predicted();
    p.reset(null);
    expect(p.ball).toBeNull();
    expect(p.step(DT, 0, null)).toBeNull();
  });
});
