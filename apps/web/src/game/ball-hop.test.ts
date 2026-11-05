import type { BallMood } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import {
  type BallHop,
  createBallHop,
  KICK_HOP_TILES,
  kickBallHop,
  PLAY_HOP_GAP_S,
  PLAY_HOP_TILES,
  stepBallHop,
} from './ball-hop';

// Ball hop spec: a drawn height under gravity, set off by a kick or by playing.
const DT = 1 / 60;

/** Steps for `seconds` and returns the highest lift seen. */
function run(hop: BallHop, seconds: number, mood: BallMood): number {
  let highest = hop.liftTiles;
  for (let t = 0; t < seconds; t += DT) {
    stepBallHop(hop, DT, mood);
    highest = Math.max(highest, hop.liftTiles);
  }
  return highest;
}

/** Each run of frames in the air: its apex, and the time on the floor before it. */
function hopsWhilePlaying(seconds: number): { apex: number; floorBeforeS: number }[] {
  const hop = createBallHop();
  const hops: { apex: number; floorBeforeS: number }[] = [];
  let floorS = 0;
  let wasInAir = false;
  for (let t = 0; t < seconds; t += DT) {
    stepBallHop(hop, DT, 'playing');
    const inAir = hop.liftTiles > 0;
    if (inAir && !wasInAir) {
      hops.push({ apex: 0, floorBeforeS: floorS });
      floorS = 0;
    }
    if (inAir) {
      const current = hops.at(-1);
      if (current) {
        current.apex = Math.max(current.apex, hop.liftTiles);
      }
    } else {
      floorS += DT;
    }
    wasInAir = inAir;
  }
  return hops;
}

describe('a kick', () => {
  test('rises to its apex and lands', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    expect(run(hop, 1.2, 'asleep')).toBeCloseTo(KICK_HOP_TILES, 1);
    expect(hop.liftTiles).toBe(0);
  });

  test('again and again in mid-air never rises past the apex', () => {
    const hop = createBallHop();
    let highest = 0;
    for (let i = 0; i < 20; i++) {
      kickBallHop(hop);
      highest = Math.max(highest, run(hop, 0.1, 'asleep'));
    }
    expect(highest).toBeLessThanOrEqual(KICK_HOP_TILES + 1e-6);
    expect(highest).toBeGreaterThan(PLAY_HOP_TILES);
  });

  test('at the apex leaves it to fall', () => {
    const hop = createBallHop();
    hop.liftTiles = KICK_HOP_TILES;
    kickBallHop(hop);
    expect(hop.upSpeed).toBe(0);
    run(hop, 1.2, 'asleep');
    expect(hop.liftTiles).toBe(0);
  });
});

describe('playing', () => {
  test('hops again and again', () => {
    const hops = hopsWhilePlaying(3);
    expect(hops.length).toBeGreaterThanOrEqual(3);
    for (const { apex } of hops) {
      expect(apex).toBeCloseTo(PLAY_HOP_TILES, 1);
    }
  });

  test('waits the gap on the floor between hops', () => {
    const [first, second] = hopsWhilePlaying(3);
    expect(first?.floorBeforeS).toBeLessThan(2 * DT);
    expect(second?.floorBeforeS).toBeCloseTo(PLAY_HOP_GAP_S, 1);
  });
});

describe('other moods', () => {
  test.each(['asleep', 'wandering', 'approaching', 'following', 'scared'] as const)(
    '%s does not hop by itself',
    (mood) => {
      expect(run(createBallHop(), 2, mood)).toBe(0);
    }
  );

  test('a hop finishes after the mood changes', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    run(hop, 0.1, 'asleep');
    const before = hop.liftTiles;
    stepBallHop(hop, DT, 'scared');
    expect(hop.liftTiles).toBeGreaterThan(before);
    run(hop, 1.2, 'scared');
    expect(hop.liftTiles).toBe(0);
  });

  test('a long step lands it on the floor', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    stepBallHop(hop, 30, 'asleep');
    expect(hop.liftTiles).toBe(0);
    expect(hop.upSpeed).toBe(0);
  });
});
