import { type PeerInfo, RIDE_SPEED, SnapshotBuffer } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { PeerDelay } from '../net/peer-delay';
import type { RemotePeer } from '../net/session';
import type { AudioEngine } from './engine';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createScooterSounds, ownLoad } from './scooter-sounds';

function fakeEngine() {
  const attached = new Map<string, string>();
  const detached: string[] = [];
  let unplaced = 0;
  const engine = {
    attachNode(key: string, _node: AudioNode, owner = key) {
      attached.set(key, owner);
    },
    detach(key: string) {
      attached.delete(key);
      detached.push(key);
    },
    playUnplaced() {
      unplaced++;
    },
  } as unknown as AudioEngine;
  return { engine, attached, detached, unplaced: () => unplaced };
}

const peer = (id: string, riding: string | null): RemotePeer =>
  ({
    info: { id, riding } as PeerInfo,
    buffer: new SnapshotBuffer(),
    delay: new PeerDelay(),
    gesture: null,
  }) as RemotePeer;

type Osc = FakeNode & { frequency: FakeParam };
/** Bump thuds made so far: oscillators whose pitch sweeps (they start with a set value at 136 Hz). */
const thuds = (ctx: FakeAudioContext) =>
  (ctx.byKind('oscillator') as unknown as Osc[]).filter((o) => o.frequency.events.at(0)?.[1] === 136).length;
/** The whiss's last level target: the layer gain the 7800 Hz tone feeds. */
function whissLevel(ctx: FakeAudioContext): number {
  const gains = ctx.byKind('gain') as unknown as (FakeNode & { gain: FakeParam })[];
  const layers = gains.filter((g) => g.gain.targets.length > 0);
  return layers.at(0)?.gain.targets.at(-1)?.[0] ?? -1;
}

const DT = 1 / 60;
/** Drives one rider along x, one frame per entry of `speeds`, starting at x = 1. */
function ride(speeds: number[], at = { x: 1, y: 1 }) {
  const ctx = new FakeAudioContext();
  const { engine } = fakeEngine();
  const sounds = createScooterSounds(asAudioContext(ctx), engine);
  const peers = new Map([['a', peer('a', 's1')]]);
  const positions = new Map([['a', at]]);
  for (const speed of speeds) {
    at.x += speed * DT;
    sounds.sync(peers, positions, DT);
  }
  return { ctx, sounds, peers, positions, at };
}
const frames = (n: number, speed: (i: number) => number) => Array.from({ length: n }, (_, i) => speed(i));

describe('ownLoad', () => {
  test('throttle below top speed pulls, at top speed cruises, anything else coasts', () => {
    expect(ownLoad(1, 3)).toBe('pulling');
    expect(ownLoad(1, RIDE_SPEED)).toBe('cruising');
    expect(ownLoad(0, 3)).toBe('coasting');
    expect(ownLoad(-1, 3)).toBe('coasting');
  });
});

describe("others' load follows their motion", () => {
  test('speeding up pulls', () => {
    expect(whissLevel(ride(frames(60, (i) => i * 4 * DT)).ctx)).toBe(0.35);
  });

  test('a steady speed cruises', () => {
    expect(whissLevel(ride(frames(90, () => RIDE_SPEED)).ctx)).toBe(0.18);
  });

  test('slowing coasts', () => {
    expect(whissLevel(ride(frames(90, (i) => RIDE_SPEED - i * 1.5 * DT)).ctx)).toBe(0.02);
  });
});

describe("others' bumps", () => {
  test('a sudden stop plays one bump', () => {
    const { ctx } = ride([...frames(30, () => RIDE_SPEED), ...frames(60, () => 0)]);
    expect(thuds(ctx)).toBe(1);
  });

  test('hard braking plays none', () => {
    const { ctx } = ride(frames(60, (i) => Math.max(0, RIDE_SPEED - i * 10 * DT)));
    expect(thuds(ctx)).toBe(0);
  });

  test('a portal jump plays none', () => {
    const { ctx } = ride([...frames(30, () => 3), 300, ...frames(30, () => 0)]);
    expect(thuds(ctx)).toBe(0);
  });
});

describe('the own sound', () => {
  test('plays unplaced while riding, bumps from the ride, and stops on stepping off', () => {
    const ctx = new FakeAudioContext();
    const { engine, unplaced } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    sounds.own(3, 'pulling', 0, true, DT);
    expect(unplaced()).toBe(1);
    sounds.own(0, 'coasting', 6, true, DT);
    expect(thuds(ctx)).toBe(1);
    sounds.own(0, 'coasting', 0, true, DT);
    expect(thuds(ctx)).toBe(1);
    sounds.own(0, 'coasting', 0, false, DT);
    const saws = ctx.byKind('oscillator') as unknown as { stoppedAt: number | null }[];
    expect(saws.every((o) => o.stoppedAt !== null)).toBe(true);
  });
});

describe('lifecycle', () => {
  test('a peer stepping on is heard from their spot, and stepping off silences them', () => {
    const ctx = new FakeAudioContext();
    const { engine, attached, detached } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    const peers = new Map([['a', peer('a', 's1')]]);
    const positions = new Map([['a', { x: 1, y: 1 }]]);
    sounds.sync(peers, positions, DT);
    expect([...attached]).toEqual([['scooter:a', 'a']]);
    const a = peers.get('a');
    if (a) {
      a.info.riding = null;
    }
    sounds.sync(peers, positions, DT);
    expect(detached).toEqual(['scooter:a']);
  });

  test('a rider who leaves while riding is silenced', () => {
    const ctx = new FakeAudioContext();
    const { engine, detached } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    sounds.sync(new Map([['a', peer('a', 's1')]]), new Map([['a', { x: 1, y: 1 }]]), DT);
    sounds.peerLeft('a');
    expect(detached).toEqual(['scooter:a']);
  });
});
