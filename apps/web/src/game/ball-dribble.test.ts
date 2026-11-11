import { describe, expect, test } from 'vitest';
import { createBallDribble, DRIBBLE_HAND_TILES, DRIBBLE_PERIOD_S, stepBallDribble } from './ball-dribble';
import { createBallHop, dropBallHopFrom, REBOUND_HEIGHT_SHARE, stepBallHop } from './ball-hop';

const DT = 1 / 60;

describe('the dribble bounce', () => {
  test('it starts at the hand', () => {
    expect(createBallDribble().liftTiles).toBeCloseTo(DRIBBLE_HAND_TILES);
  });

  test('it stays between the floor and the hand', () => {
    const d = createBallDribble();
    for (let i = 0; i < 600; i++) {
      stepBallDribble(d, DT);
      expect(d.liftTiles).toBeGreaterThanOrEqual(0);
      expect(d.liftTiles).toBeLessThanOrEqual(DRIBBLE_HAND_TILES + 1e-9);
    }
  });

  test('it touches the floor once a period', () => {
    const d = createBallDribble();
    let touches = 0;
    for (let i = 0; i < 600; i++) {
      touches += stepBallDribble(d, DT) ? 1 : 0;
    }
    expect(Math.abs(touches - 10 / DRIBBLE_PERIOD_S)).toBeLessThanOrEqual(1);
  });

  test('it moves fastest at the floor', () => {
    const d = createBallDribble();
    let fastest = 0;
    let fastestLift = 0;
    let last = d.liftTiles;
    for (let i = 0; i < 60; i++) {
      stepBallDribble(d, DT);
      const speed = Math.abs(d.liftTiles - last);
      if (speed > fastest) {
        fastest = speed;
        fastestLift = Math.min(last, d.liftTiles);
      }
      last = d.liftTiles;
    }
    expect(fastestLift).toBeLessThan(DRIBBLE_HAND_TILES * 0.2);
  });
});

describe('letting go mid-bounce', () => {
  test('a hop dropped from a height falls from there and rebounds by its share', () => {
    const hop = createBallHop();
    dropBallHopFrom(hop, 0.4);
    expect(hop.liftTiles).toBeCloseTo(0.4);
    let landed = false;
    let highest = 0;
    for (let i = 0; i < 120; i++) {
      stepBallHop(hop, DT, 'asleep');
      if (hop.liftTiles === 0) {
        landed = true;
      }
      if (landed) {
        highest = Math.max(highest, hop.liftTiles);
      }
    }
    expect(landed).toBe(true);
    expect(highest).toBeCloseTo(0.4 * REBOUND_HEIGHT_SHARE, 1);
  });
});
