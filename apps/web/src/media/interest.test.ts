import { FOV_WIDE, parseMap } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import {
  createInterest,
  HOLD_MS,
  type InterestInput,
  LOOKAHEAD_TILES,
  MAX_VIDEOS,
  MAX_VOICES,
  type PeerFacts,
} from './interest';

// 40 × 9: one open room with a single pillar at (8, 4), right in front of the player.
const MAP = parseMap(
  [
    '1111111111111111111111111111111111111111',
    '1......................................1',
    '1......................................1',
    '1......................................1',
    '1.S.....1..............................1',
    '1......................................1',
    '1......................................1',
    '1......................................1',
    '1111111111111111111111111111111111111111',
  ].join('\n')
);
const PLAYER = { x: 2.5, y: 4.5, angle: 0 };
const MAX = 24;

type Peer = { id: string; x: number; y: number };

function input(peers: Peer[], facts: Record<string, PeerFacts> = {}, over: Partial<InterestInput> = {}): InterestInput {
  return {
    now: 0,
    hidden: false,
    player: PLAYER,
    fov: FOV_WIDE,
    map: MAP,
    maxDistance: MAX,
    peers,
    facts: (id) => facts[id],
    ...over,
  };
}

const drawn = (projectedSize: number): PeerFacts => ({ drawnColumns: 10, projectedSize });
const NEAR: Peer = { id: 'a', x: 5.5, y: 4.5 };

describe('video for drawn peers follows their on-screen size', () => {
  test.each([
    [200, 256],
    [128, 256],
    [127, 128],
    [48, 128],
    [47, 64],
    [5, 64],
  ])('%i px → %s', (size, want) => {
    const wants = createInterest().update(input([NEAR], { a: drawn(size) }));
    expect(wants.get('a')?.video).toBe(want);
  });

  test('a peer with no drawn columns and out of sight is off', () => {
    const behind = { id: 'a', x: 1.5, y: 4.5 };
    const wants = createInterest().update(input([behind], { a: { drawnColumns: 0, projectedSize: 300 } }));
    expect(wants.get('a')?.video).toBe('off');
  });
});

describe('size hysteresis (20% below each threshold)', () => {
  test('256 is kept down to 80% of 128 px, then drops (after the hold)', () => {
    const rule = createInterest();
    rule.update(input([NEAR], { a: drawn(130) }, { now: 0 }));
    expect(rule.update(input([NEAR], { a: drawn(103) }, { now: 5000 })).get('a')?.video).toBe(256);
    rule.update(input([NEAR], { a: drawn(100) }, { now: 6000 }));
    expect(rule.update(input([NEAR], { a: drawn(100) }, { now: 6000 + HOLD_MS })).get('a')?.video).toBe(128);
  });

  test('128 is kept down to 80% of 48 px', () => {
    const rule = createInterest();
    rule.update(input([NEAR], { a: drawn(50) }, { now: 0 }));
    expect(rule.update(input([NEAR], { a: drawn(39) }, { now: 5000 })).get('a')?.video).toBe(128);
    rule.update(input([NEAR], { a: drawn(38) }, { now: 6000 }));
    expect(rule.update(input([NEAR], { a: drawn(38) }, { now: 6000 + HOLD_MS })).get('a')?.video).toBe(64);
  });

  test('flickering around a threshold never flaps', () => {
    const rule = createInterest();
    const seen = new Set<unknown>();
    for (let t = 0; t < 10_000; t += 250) {
      const size = t % 500 === 0 ? 130 : 110;
      seen.add(rule.update(input([NEAR], { a: drawn(size) }, { now: t })).get('a')?.video);
    }
    expect([...seen]).toEqual([256]);
  });
});

describe('holds: up at once, down only after HOLD_MS', () => {
  test('an upgrade is immediate', () => {
    const rule = createInterest();
    rule.update(input([NEAR], { a: drawn(20) }, { now: 0 }));
    expect(rule.update(input([NEAR], { a: drawn(200) }, { now: 10 })).get('a')?.video).toBe(256);
  });

  test('a downgrade waits HOLD_MS of continuously wanting less', () => {
    const rule = createInterest();
    rule.update(input([NEAR], { a: drawn(200) }, { now: 0 }));
    expect(rule.update(input([NEAR], { a: drawn(20) }, { now: 100 })).get('a')?.video).toBe(256);
    expect(rule.update(input([NEAR], { a: drawn(20) }, { now: 100 + HOLD_MS - 1 })).get('a')?.video).toBe(256);
    expect(rule.update(input([NEAR], { a: drawn(20) }, { now: 100 + HOLD_MS })).get('a')?.video).toBe(64);
  });

  test('going off waits HOLD_MS too', () => {
    const rule = createInterest();
    const behind = { id: 'a', x: 1.5, y: 4.5 };
    rule.update(input([NEAR], { a: drawn(200) }, { now: 0 }));
    expect(rule.update(input([behind], {}, { now: 100 })).get('a')?.video).toBe(256);
    expect(rule.update(input([behind], {}, { now: 100 + HOLD_MS })).get('a')?.video).toBe('off');
  });

  test('wanting more again in between restarts the hold', () => {
    const rule = createInterest();
    rule.update(input([NEAR], { a: drawn(200) }, { now: 0 }));
    rule.update(input([NEAR], { a: drawn(20) }, { now: 100 }));
    rule.update(input([NEAR], { a: drawn(200) }, { now: 600 }));
    expect(rule.update(input([NEAR], { a: drawn(20) }, { now: 700 })).get('a')?.video).toBe(256);
    expect(rule.update(input([NEAR], { a: drawn(20) }, { now: 100 + HOLD_MS })).get('a')?.video).toBe(256);
    expect(rule.update(input([NEAR], { a: drawn(20) }, { now: 700 + HOLD_MS })).get('a')?.video).toBe(64);
  });
});

describe('look-ahead for peers not drawn', () => {
  test('in view and in line of sight → 64', () => {
    expect(
      createInterest()
        .update(input([NEAR]))
        .get('a')?.video
    ).toBe(64);
  });

  test('in view but hidden behind someone nearer (0 columns seen) → off', () => {
    const covered = { drawnColumns: 0, projectedSize: 30 };
    expect(
      createInterest()
        .update(input([NEAR], { a: covered }))
        .get('a')?.video
    ).toBe('off');
  });

  test('in view but too close to project (standing on top of us, size 0) → 64, as look-ahead', () => {
    const tooClose = { drawnColumns: 0, projectedSize: 0 };
    expect(
      createInterest()
        .update(input([NEAR], { a: tooClose }))
        .get('a')?.video
    ).toBe(64);
  });

  test('just outside the view but within the widened view → 64', () => {
    // 45° to the right: outside the 33° half-FOV, inside 33° + 15°.
    const side = { id: 'a', x: 5.5, y: 7.5 };
    expect(
      createInterest()
        .update(input([side]))
        .get('a')?.video
    ).toBe(64);
  });

  test('outside the widened view → off', () => {
    // About 60° to the right.
    const side = { id: 'a', x: 4.5, y: 7.9 };
    expect(
      createInterest()
        .update(input([side]))
        .get('a')?.video
    ).toBe('off');
  });

  test('behind a wall (no line of sight) → off', () => {
    const hidden = { id: 'a', x: 12.5, y: 4.5 };
    expect(
      createInterest()
        .update(input([hidden]))
        .get('a')?.video
    ).toBe('off');
  });

  test(`beyond ${LOOKAHEAD_TILES} tiles → off`, () => {
    const far = { id: 'a', x: 24.5, y: 7.5 };
    expect(
      createInterest()
        .update(input([far]))
        .get('a')?.video
    ).toBe('off');
  });

  test('behind the player → off', () => {
    const behind = { id: 'a', x: 1.5, y: 4.5 };
    expect(
      createInterest()
        .update(input([behind]))
        .get('a')?.video
    ).toBe('off');
  });
});

describe('a hidden tab', () => {
  test('turns every video off at once and keeps audio', () => {
    const rule = createInterest();
    rule.update(input([NEAR], { a: drawn(200) }, { now: 0 }));
    const wants = rule.update(input([NEAR], { a: drawn(200) }, { now: 10, hidden: true }));
    expect(wants.get('a')).toEqual({ video: 'off', audio: true });
  });

  test('video comes back at once when visible again', () => {
    const rule = createInterest();
    rule.update(input([NEAR], { a: drawn(200) }, { now: 0, hidden: true }));
    expect(rule.update(input([NEAR], { a: drawn(200) }, { now: 10 })).get('a')?.video).toBe(256);
  });
});

describe('audio range with hysteresis', () => {
  // A long corridor; the player faces away (audio doesn't care where they look).
  const MAP_LONG = parseMap(['1'.repeat(62), `1S${'.'.repeat(59)}1`, '1'.repeat(62)].join('\n'));
  const peerAt = (d: number): Peer => ({ id: 'a', x: 1.5 + d, y: 1.5 });
  const player = { x: 1.5, y: 1.5, angle: Math.PI };
  const step = (rule: ReturnType<typeof createInterest>, d: number) =>
    rule.update(input([peerAt(d)], {}, { map: MAP_LONG, player })).get('a')?.audio;

  test('on within max + 2', () => {
    expect(step(createInterest(), MAX + 2)).toBe(true);
    expect(step(createInterest(), MAX + 2.1)).toBe(false);
  });

  test('kept until beyond max + 4', () => {
    const rule = createInterest();
    step(rule, MAX);
    expect(step(rule, MAX + 4)).toBe(true);
    expect(step(rule, MAX + 4.1)).toBe(false);
    expect(step(rule, MAX + 3)).toBe(false);
  });
});

describe('caps, nearest first', () => {
  const crowd = (n: number): Peer[] =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, x: 4.5 + i * 0.5, y: 2.5 + (i % 2) }));

  test(`only the ${MAX_VIDEOS} nearest drawn peers get video`, () => {
    const peers = crowd(MAX_VIDEOS + 1);
    const facts = Object.fromEntries(peers.map((p) => [p.id, drawn(100)]));
    const wants = createInterest().update(input(peers, facts));
    expect(peers.filter((p) => wants.get(p.id)?.video !== 'off')).toHaveLength(MAX_VIDEOS);
    expect(wants.get(`p${MAX_VIDEOS}`)?.video).toBe('off');
  });

  test(`only the ${MAX_VOICES} nearest peers get audio`, () => {
    const peers = crowd(MAX_VOICES + 1);
    const wants = createInterest().update(input(peers));
    expect(peers.filter((p) => wants.get(p.id)?.audio)).toHaveLength(MAX_VOICES);
    expect(wants.get(`p${MAX_VOICES}`)?.audio).toBe(false);
  });
});

test('a peer no longer listed is forgotten', () => {
  const rule = createInterest();
  rule.update(input([NEAR], { a: drawn(200) }, { now: 0 }));
  expect(rule.update(input([], {}, { now: 10 })).has('a')).toBe(false);
  // Back again later: no stale hold from before.
  const behind = { id: 'a', x: 1.5, y: 4.5 };
  expect(rule.update(input([behind], {}, { now: 20 })).get('a')?.video).toBe('off');
});
