import type { BallMood } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import {
  type BallHop,
  createBallHop,
  KICK_HOP_TILES,
  kickBallHop,
  PLAY_HOP_GAP_S,
  PLAY_HOP_TILES,
  REBOUND_HEIGHT_SHARE,
  stepBallHop,
} from './ball-hop';

// Ball hop spec: a drawn height under gravity, set off by a kick or by playing, that rebounds lower each landing.
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

interface Flight {
  apex: number;
  startS: number;
  floorBeforeS: number;
}

/** Each run of frames in the air: its apex, when it left, and the time on the floor before it. */
function flights(hop: BallHop, seconds: number, mood: BallMood): Flight[] {
  const all: Flight[] = [];
  let floorS = 0;
  let wasInAir = hop.liftTiles > 0;
  for (let t = 0; t < seconds; t += DT) {
    stepBallHop(hop, DT, mood);
    const inAir = hop.liftTiles > 0;
    if (inAir && !wasInAir) {
      all.push({ apex: 0, startS: t, floorBeforeS: floorS });
      floorS = 0;
    }
    if (inAir) {
      const current = all.at(-1);
      if (current) {
        current.apex = Math.max(current.apex, hop.liftTiles);
      }
    } else {
      floorS += DT;
    }
    wasInAir = inAir;
  }
  return all;
}

/** A rebound leaves on the frame after it lands; a new jump leaves from a ball at rest. */
const jumps = (all: Flight[]) => all.filter((f, i) => i === 0 || f.floorBeforeS > 2 * DT);

describe('a kick', () => {
  test('rises to its apex and settles', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    expect(run(hop, 2, 'asleep')).toBeCloseTo(KICK_HOP_TILES, 1);
    expect(hop.liftTiles).toBe(0);
    expect(hop.upSpeed).toBe(0);
  });

  test('is quick: its first landing comes within half a second', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    const [, firstRebound] = flights(hop, 0.6, 'asleep');
    expect(firstRebound?.startS).toBeLessThan(0.5);
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
    run(hop, 2, 'asleep');
    expect(hop.liftTiles).toBe(0);
  });
});

describe('the spring', () => {
  test('each rebound reaches a share of the one before', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    const [first, second, third] = flights(hop, 2, 'asleep');
    expect(first?.apex).toBeCloseTo(KICK_HOP_TILES, 1);
    expect(second?.apex).toBeCloseTo(KICK_HOP_TILES * REBOUND_HEIGHT_SHARE, 1);
    expect(third?.apex).toBeCloseTo(KICK_HOP_TILES * REBOUND_HEIGHT_SHARE ** 2, 1);
  });

  test('it rebounds at once, with no rest on the floor', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    const [, rebound] = flights(hop, 1, 'asleep');
    expect(rebound?.floorBeforeS).toBeLessThanOrEqual(DT);
  });

  test('it settles after a few rebounds and stays down', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    const all = flights(hop, 3, 'asleep');
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.length).toBeLessThanOrEqual(6);
    expect(run(hop, 1, 'asleep')).toBe(0);
  });

  test('long steps never throw it higher than it fell from, and it settles', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    for (let i = 0; i < 10; i++) {
      stepBallHop(hop, 30, 'asleep');
      expect(hop.liftTiles).toBe(0);
    }
    expect(hop.upSpeed).toBe(0);
  });
});

describe('playing', () => {
  test('jumps again and again, each to the play height', () => {
    const all = jumps(flights(createBallHop(), 3, 'playing'));
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const { apex } of all) {
      expect(apex).toBeCloseTo(PLAY_HOP_TILES, 1);
    }
  });

  test('waits the gap on the floor once settled', () => {
    const [first, second] = jumps(flights(createBallHop(), 3, 'playing'));
    expect(first?.floorBeforeS).toBeLessThan(2 * DT);
    expect(second?.floorBeforeS).toBeCloseTo(PLAY_HOP_GAP_S, 1);
  });

  test('waits the gap after a kick hop settles too', () => {
    const hop = createBallHop();
    kickBallHop(hop);
    const all = flights(hop, 3, 'playing');
    const rises = all.filter((f, i) => i > 0 && f.apex > (all.at(i - 1)?.apex ?? 0));
    expect(rises.length).toBeGreaterThan(0);
    for (const f of rises) {
      expect(f.floorBeforeS).toBeCloseTo(PLAY_HOP_GAP_S, 1);
    }
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
    run(hop, 2, 'scared');
    expect(hop.liftTiles).toBe(0);
  });
});
