import { type PeerInfo, parseMap, RIDE_SPEED, SnapshotBuffer } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createRideState, stepRide } from '../game/scooter-physics';
import { PeerDelay } from '../net/peer-delay';
import type { RemotePeer } from '../net/session';
import type { AudioEngine } from './engine';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createScooterSounds, ownLoad } from './scooter-sounds';

function fakeEngine() {
  const attached = new Map<string, string>();
  const detached: string[] = [];
  let own = 0;
  const engine = {
    attachNode(key: string, _node: AudioNode, owner = key) {
      attached.set(key, owner);
    },
    detach(key: string) {
      attached.delete(key);
      detached.push(key);
    },
    playOwn() {
      own++;
    },
  } as unknown as AudioEngine;
  return { engine, attached, detached, own: () => own };
}

const peer = (id: string, riding: string | null): RemotePeer => {
  const delay = new PeerDelay();
  delay.value = 150;
  return { info: { id, riding } as PeerInfo, buffer: new SnapshotBuffer(), delay, gesture: null } as RemotePeer;
};

type Osc = FakeNode & { frequency: FakeParam; startedAt: number | null; onended: (() => void) | null };
const thuds = (ctx: FakeAudioContext) =>
  (ctx.byKind('oscillator') as unknown as Osc[]).filter((o) => o.frequency.events.at(0)?.[1] === 136);
/** The whiss layer's last level target (the first layer gain to be glided). */
function whissLevel(ctx: FakeAudioContext): number {
  const gains = (ctx.byKind('gain') as unknown as (FakeNode & { gain: FakeParam })[]).filter(
    (g) => g.gain.targets.length > 0
  );
  return gains.at(0)?.gain.targets.at(-1)?.[0] ?? -1;
}

const DT = 1 / 60;
const FRAME_MS = 1000 / 60;

/** A rider whose snapshots arrive every 66 ms at `speed` until `stopAtMs`; synced every frame until `untilMs`. */
function ride(speed: number, untilMs: number, stopAtMs = Number.POSITIVE_INFINITY) {
  const ctx = new FakeAudioContext();
  const { engine } = fakeEngine();
  const sounds = createScooterSounds(asAudioContext(ctx), engine);
  const a = peer('a', 's1');
  const peers = new Map([['a', a]]);
  const positions = new Map([['a', { x: 0, y: 0 }]]);
  let nextSnapshotMs = 0;
  for (let now = 0; now <= untilMs; now += FRAME_MS) {
    while (nextSnapshotMs <= Math.min(now, stopAtMs)) {
      a.buffer.push({ t: nextSnapshotMs, x: (speed * nextSnapshotMs) / 1000, y: 0, angle: 0 });
      nextSnapshotMs += 66;
    }
    sounds.sync(peers, positions, DT, now);
  }
  return { ctx, sounds };
}

describe('ownLoad', () => {
  test('throttle below top speed pulls, at top speed cruises, anything else coasts', () => {
    expect(ownLoad(1, 3)).toBe('pulling');
    expect(ownLoad(1, RIDE_SPEED)).toBe('cruising');
    expect(ownLoad(0, 3)).toBe('coasting');
    expect(ownLoad(-1, 3)).toBe('coasting');
  });
});

describe('others, from their snapshots', () => {
  test('a rider holding full speed is heard cruising', () => {
    expect(whissLevel(ride(RIDE_SPEED, 3000).ctx)).toBe(0.18);
  });

  test('a rider stopping dead bumps once, scheduled for when the stop is drawn', () => {
    const { ctx } = ride(RIDE_SPEED, 3000, 1000);
    const hits = thuds(ctx);
    expect(hits).toHaveLength(1);
    expect(hits.at(0)?.startedAt).toBeGreaterThanOrEqual(ctx.currentTime);
  });
});

describe('the own sound', () => {
  test('throttling into a wall for a second bumps at most once', () => {
    const ctx = new FakeAudioContext();
    const { engine } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    const hall = parseMap(['1111111', '1S....1', '1111111'].join('\n'));
    const pose = { x: 4.5, y: 1.5, angle: 0 };
    const state = { ...createRideState(), speed: RIDE_SPEED };
    for (let i = 0; i < 90; i++) {
      stepRide(hall, pose, state, { forward: 1, strafe: 0, turn: 0 }, DT, null);
      sounds.own(state.speed, ownLoad(1, state.speed), state.bump, true, DT);
    }
    expect(thuds(ctx)).toHaveLength(1);
  });

  test('plays through the room reverb while riding, and stops on stepping off', () => {
    const ctx = new FakeAudioContext();
    const { engine, own } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    sounds.own(3, 'pulling', 0, true, DT);
    sounds.own(3, 'pulling', 0, true, DT);
    expect(own()).toBe(1);
    sounds.own(0, 'coasting', 0, false, DT);
    const oscillators = ctx.byKind('oscillator') as unknown as { stoppedAt: number | null }[];
    expect(oscillators.every((o) => o.stoppedAt !== null)).toBe(true);
  });
});

describe('lifecycle', () => {
  const setUp = () => {
    const ctx = new FakeAudioContext();
    const fake = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), fake.engine);
    const peers = new Map([['a', peer('a', 's1')]]);
    const positions = new Map([['a', { x: 1, y: 1 }]]);
    sounds.sync(peers, positions, DT, 0);
    return { ctx, sounds, peers, positions, ...fake };
  };
  /** Ends every oscillator, as the audio clock would once their fade is over. */
  const fadeOut = (ctx: FakeAudioContext) => {
    for (const o of ctx.byKind('oscillator') as unknown as Osc[]) {
      o.onended?.();
    }
  };

  test('a rider is heard from their spot, and stepping off fades them out before letting go', () => {
    const { ctx, sounds, peers, positions, attached, detached } = setUp();
    expect([...attached.values()]).toEqual(['a']);
    const a = peers.get('a');
    if (a) {
      a.info.riding = null;
    }
    sounds.sync(peers, positions, DT, 16);
    expect(detached).toEqual([]);
    fadeOut(ctx);
    expect(detached).toHaveLength(1);
  });

  test('a rider who leaves is let go once faded', () => {
    const { ctx, sounds, detached } = setUp();
    sounds.peerLeft('a');
    expect(detached).toEqual([]);
    fadeOut(ctx);
    expect(detached).toHaveLength(1);
  });

  test('stepping straight back on gets a new sound the old fade never touches', () => {
    const { ctx, sounds, peers, positions, attached, detached } = setUp();
    const a = peers.get('a');
    if (a) {
      a.info.riding = null;
      sounds.sync(peers, positions, DT, 16);
      a.info.riding = 's1';
      sounds.sync(peers, positions, DT, 32);
    }
    const [newKey] = [...attached.keys()].slice(-1);
    fadeOut(ctx);
    expect(detached).not.toContain(newKey);
    expect(attached.has(newKey ?? '')).toBe(true);
  });
});
