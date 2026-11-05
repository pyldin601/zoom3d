import { type BallBody, type ObjectInfo, type ObjectStateMessage, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { twoDoorways } from '../../../../packages/shared/src/portals/test-doorways';
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

  test('a still player resting against the ball does not hold off the server', () => {
    const p = predicted(3, 3.5);
    p.server(state(5, 3.5), 'me', 0);
    for (let i = 0; i < 30; i++) {
      p.step(DT, i * 16, walker(2.55, 3.5, 0));
    }
    expect(ballOf(p).x).toBeGreaterThan(4);
  });

  test('the own kick echo ends the hold', () => {
    const p = predicted();
    const k = p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    expect(k).toBe(1);
    p.server(state(7, 3.5, { event: 'kick', by: 'me', k: 1 }), 'me', 50);
    p.step(0, 50, null);
    expect(ballOf(p).x).toBe(7);
  });

  test("someone else's kick does not end it", () => {
    const p = predicted();
    p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    p.server(state(6, 3.5, { event: 'kick', by: 'other', k: 1 }), 'me', 50);
    p.step(0, 50, null);
    expect(ballOf(p).x).toBe(3);
  });

  test('a kick waits for its echo on a link slower than the hold', () => {
    const p = predicted();
    p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    p.server(state(3, 3.5), 'me', 400);
    p.step(DT, 400, null);
    expect(ballOf(p).vx).toBeGreaterThan(7);
  });

  test('a kick that never hears back gives up after a second', () => {
    const p = predicted();
    p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    p.server(state(3, 3.5), 'me', 1100);
    p.step(DT, 1100, null);
    expect(ballOf(p).vx).toBe(0);
  });

  describe('a server ball that moves away during a push', () => {
    const movedAway = state(3.5, 3.5, { vx: 8 });
    /** Pushes for a few frames, delivers the state to the pusher and a watcher, then keeps stepping for 300 ms. */
    function playOut(walkerAt: (ballX: number, t: number) => number) {
      const pusher = predicted();
      const watcher = predicted();
      let t = 0;
      const frame = () => {
        pusher.step(DT, t, walker(walkerAt(ballOf(pusher).x, t), 3.5, 3));
        watcher.step(DT, t, null);
        t += 1000 * DT;
      };
      for (let i = 0; i < 3; i++) {
        frame();
      }
      pusher.server(movedAway, 'me', t);
      watcher.server(movedAway, 'watcher', t);
      let largestMove = 0;
      for (let i = 0; i < 18; i++) {
        const before = ballOf(pusher).x;
        frame();
        largestMove = Math.max(largestMove, Math.abs(ballOf(pusher).x - before));
      }
      return { gap: Math.abs(ballOf(pusher).x - ballOf(watcher).x), largestMove };
    }

    test('stops holding once it has drifted, so the ball glides after it', () => {
      const { gap, largestMove } = playOut((_, t) => 2.6 + (3 * t) / 1000);
      expect(gap).toBeLessThan(1);
      expect(largestMove).toBeLessThan(0.5);
    });

    test('is followed even by a player still walking into the ball', () => {
      const { gap, largestMove } = playOut((ballX) => ballX - 0.4);
      expect(gap).toBeLessThan(1);
      expect(largestMove).toBeLessThan(0.5);
    });
  });

  test('a far server ball leaves a local kick waiting for its own answer', () => {
    const p = predicted();
    expect(p.kick({ x: 2.6, y: 3.5 }, 0, 0)).toBe(1);
    p.server(state(3, 3.5, { event: 'kick', by: 'other', k: 1, vx: -8 }), 'me', 20);
    p.step(DT, 40, null);
    expect(ballOf(p).vx).toBeGreaterThan(0);
  });

  test('a refused kick ends the hold at once', () => {
    const p = predicted();
    const k = p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    p.step(0.05, 50, null);
    p.refused(k ?? -1, 50);
    p.step(DT, 66, null);
    expect(ballOf(p).vx).toBe(0);
    expect(ballOf(p).x).toBeLessThan(3.4);
  });

  test('a refusal of an older kick leaves the newer one held', () => {
    const p = predicted();
    p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    p.kick({ x: 2.6, y: 3.5 }, 0, 260);
    p.refused(1, 270);
    p.step(DT, 280, null);
    expect(ballOf(p).vx).toBeGreaterThan(7);
  });

  test('a refused kick returns the ball to the welcome spot though no server state ever came', () => {
    const p = predicted(3, 3.5);
    const k = p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    p.refused(k ?? -1, 50);
    for (let i = 0; i < 60; i++) {
      p.step(DT, 50 + i * 16, null);
    }
    expect(ballOf(p).x).toBe(3);
    expect(ballOf(p).vx).toBe(0);
  });

  test('a second kick within 250 ms is not made, as the server would drop it', () => {
    const p = predicted();
    expect(p.kick({ x: 2.6, y: 3.5 }, 0, 0)).toBe(1);
    ballOf(p).vx = 0;
    expect(p.kick({ x: 2.6, y: 3.5 }, Math.PI, 100)).toBeNull();
    expect(ballOf(p).vx).toBe(0);
    expect(p.kick({ x: 2.6, y: 3.5 }, 0, 260)).toBe(2);
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

  test('it snaps when the error is over 3 tiles', () => {
    const p = predicted(2, 3.5);
    p.server(state(6, 3.5), 'me', 0);
    p.step(DT, 0, null);
    expect(ballOf(p).x).toBe(6);
  });

  test("someone else's kick reversing a rolling ball glides, however far ahead the state is", () => {
    const p = predicted(5, 3.5);
    p.server(state(3, 3.5, { vx: -7, event: 'kick', by: 'other', k: 1 }), 'me', 0);
    p.step(DT, 0, null);
    expect(ballOf(p).x).toBeGreaterThan(4.3);
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

// Portal doorways spec §2.4: the prediction steps like the server, which sees bodies where they appear from the ball.
describe('through portals', () => {
  const { map, portals } = twoDoorways();
  const through = (p: ReturnType<typeof createBallPrediction>) => {
    p.reset({ ...info('b', 2.5, 3.2), vy: 3 });
    for (let i = 0; i < 20; i++) {
      p.step(DT, i * 16, null);
    }
    return ballOf(p);
  };

  test('a ball rolling south through A comes out of B rolling north', () => {
    const ball = through(createBallPrediction(map, () => portals));
    expect(ball.x).toBeCloseTo(4.5);
    expect(ball.vy).toBeLessThan(0);
  });

  test('without portals it stays on the south side', () => {
    const ball = through(createBallPrediction(map));
    expect(ball.x).toBeCloseTo(2.5);
    expect(ball.y).toBeGreaterThan(3.5);
  });

  test("a player at B pushes the ball at A, in A's frame", () => {
    const p = createBallPrediction(map, () => portals);
    p.reset(info('b', 2.5, 3.3));
    p.step(DT, 0, { kind: 'person', x: 4.5, y: 3.3, vx: 0, vy: 3, radius: 0.25 });
    expect(ballOf(p).vy).toBeLessThan(0);
  });

  test('a player at B does not touch the ball at A without portals', () => {
    const p = createBallPrediction(map);
    p.reset(info('b', 2.5, 3.3));
    p.step(DT, 0, { kind: 'person', x: 4.5, y: 3.3, vx: 0, vy: 3, radius: 0.25 });
    expect(ballOf(p).vy).toBe(0);
  });

  test('a kick from B aims through the doorway, as the server turns it', () => {
    const p = createBallPrediction(map, () => portals);
    p.reset(info('b', 2.5, 3.3));
    expect(p.kick({ x: 4.5, y: 3.3 }, Math.PI / 2, 0)).toBe(1);
    expect(ballOf(p).vy).toBeLessThan(0);
    expect(ballOf(p).vx).toBeCloseTo(0);
  });
});

// Living ball spec §3: the mood follows the server's, except that a local kick stops it on that frame.
describe('its mood', () => {
  const FROM = { x: 2.6, y: 3.5 };
  const playing = (seq = 1) => state(3, 3.5, { mood: 'playing', seq });

  test('a welcome says its mood, and no mood means asleep', () => {
    const p = createBallPrediction(MAP);
    p.reset({ ...info('b', 3, 3.5), mood: 'scared' });
    expect(p.mood).toBe('scared');
    p.reset(info('b', 3, 3.5));
    expect(p.mood).toBe('asleep');
  });

  test("a server state's mood shows on the next step", () => {
    const p = predicted();
    p.server(playing(), 'me', 0);
    p.step(DT, 0, null);
    expect(p.mood).toBe('playing');
  });

  test("another ball's state says nothing about this one", () => {
    const p = predicted();
    p.server({ ...playing(), id: 'other' }, 'me', 0);
    p.step(DT, 0, null);
    expect(p.mood).toBe('asleep');
  });

  const kicked = () => {
    const p = predicted();
    p.server(playing(), 'me', 0);
    p.step(DT, 0, null);
    expect(p.kick(FROM, 0, 100)).toBe(1);
    return p;
  };

  test('a local kick sleeps it at once', () => {
    expect(kicked().mood).toBe('asleep');
  });

  test('server states are ignored until the kick is answered', () => {
    const p = kicked();
    p.server(playing(2), 'me', 120);
    p.step(DT, 120, null);
    expect(p.mood).toBe('asleep');
  });

  test('the echo hands the mood back to the server', () => {
    const p = kicked();
    p.server(state(3, 3.5, { mood: 'following', event: 'kick', by: 'me', k: 1, seq: 2 }), 'me', 150);
    p.step(DT, 150, null);
    expect(p.mood).toBe('following');
  });

  test('a refusal hands the mood back to the server', () => {
    const p = kicked();
    p.refused(1, 150);
    p.step(DT, 150, null);
    expect(p.mood).toBe('playing');
  });

  test('with no answer in a second, the mood comes back anyway', () => {
    const p = kicked();
    p.step(DT, 1099, null);
    expect(p.mood).toBe('asleep');
    p.step(DT, 1101, null);
    expect(p.mood).toBe('playing');
  });

  test("a reconnect's welcome replaces a held kick's mood", () => {
    const p = kicked();
    p.reset({ ...info('b', 3, 3.5), mood: 'wandering' });
    p.step(DT, 120, null);
    expect(p.mood).toBe('wandering');
  });

  test('a forced mood wins until it is lifted', () => {
    const p = predicted();
    p.forceMood('scared');
    p.server(playing(), 'me', 0);
    p.step(DT, 0, null);
    expect(p.mood).toBe('scared');
    p.forceMood(null);
    expect(p.mood).toBe('playing');
  });

  test('a mood never moves the ball', () => {
    const p = predicted();
    p.server(state(3, 3.5, { mood: 'scared' }), 'me', 0);
    p.step(DT, 0, null);
    expect(ballOf(p).x).toBe(3);
    expect(ballOf(p).y).toBe(3.5);
  });
});

describe('the hop', () => {
  const stepFor = (p: ReturnType<typeof createBallPrediction>, frames: number) => {
    let highest = 0;
    for (let i = 0; i < frames; i++) {
      p.step(DT, i * DT * 1000, null);
      highest = Math.max(highest, p.lift);
    }
    return highest;
  };

  test('a local kick lifts the ball', () => {
    const p = predicted();
    expect(p.kick({ x: 2.6, y: 3.5 }, 0, 0)).not.toBeNull();
    expect(stepFor(p, 5)).toBeGreaterThan(0);
  });

  test('a kick out of reach does not', () => {
    const p = predicted();
    expect(p.kick({ x: 8, y: 3.5 }, 0, 0)).toBeNull();
    expect(stepFor(p, 5)).toBe(0);
  });

  test('someone else’s kick lifts it', () => {
    const p = predicted();
    p.server(state(3, 3.5, { event: 'kick', by: 'other' }), 'me', 0);
    expect(stepFor(p, 5)).toBeGreaterThan(0);
  });

  test('the vacuum’s knock lifts it', () => {
    const p = predicted();
    p.server(state(3, 3.5, { event: 'kick' }), 'me', 0);
    expect(stepFor(p, 5)).toBeGreaterThan(0);
  });

  test('the local player’s own echo starts no second hop', () => {
    const p = predicted();
    const k = p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    stepFor(p, 120);
    expect(p.lift).toBe(0);
    p.server(state(3, 3.5, { event: 'kick', by: 'me', k: k ?? 0 }), 'me', 0);
    expect(stepFor(p, 5)).toBe(0);
  });

  test('a playing ball hops', () => {
    const p = predicted();
    p.server(state(3, 3.5, { mood: 'playing' }), 'me', 0);
    expect(stepFor(p, 60)).toBeGreaterThan(0);
  });

  test('a scared ball does not', () => {
    const p = predicted();
    p.server(state(3, 3.5, { mood: 'scared' }), 'me', 0);
    expect(stepFor(p, 60)).toBe(0);
  });

  test('a forced mood hops like the real one', () => {
    const p = predicted();
    p.forceMood('playing');
    expect(stepFor(p, 60)).toBeGreaterThan(0);
  });

  test('a new welcome starts on the floor', () => {
    const p = predicted();
    p.kick({ x: 2.6, y: 3.5 }, 0, 0);
    stepFor(p, 5);
    expect(p.lift).toBeGreaterThan(0);
    p.reset(info('b', 3, 3.5));
    expect(p.lift).toBe(0);
  });
});
