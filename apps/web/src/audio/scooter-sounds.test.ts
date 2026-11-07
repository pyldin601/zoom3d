import { type PeerInfo, SnapshotBuffer } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { PeerDelay } from '../net/peer-delay';
import type { RemotePeer } from '../net/session';
import type { AudioEngine } from './engine';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createScooterSounds } from './scooter-sounds';

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

/** The last level the whine was told to glide to. */
function level(ctx: FakeAudioContext): number {
  const gains = (ctx.byKind('gain') as unknown as (FakeNode & { gain: FakeParam })[]).filter(
    (g) => g.gain.targets.length > 0
  );
  return gains.at(-1)?.gain.targets.at(-1)?.[0] ?? 0;
}

describe('createScooterSounds', () => {
  test('a peer stepping on is heard from their spot, and stepping off silences them', () => {
    const ctx = new FakeAudioContext();
    const { engine, attached, detached } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    const peers = new Map([['a', peer('a', 's1')]]);
    const positions = new Map([['a', { x: 1, y: 1 }]]);
    sounds.sync(peers, positions, 1 / 60);
    expect([...attached]).toEqual([['scooter:a', 'a']]);
    const a = peers.get('a');
    if (a) {
      a.info.riding = null;
    }
    sounds.sync(peers, positions, 1 / 60);
    expect(detached).toEqual(['scooter:a']);
  });

  test('a rider who leaves while riding is silenced', () => {
    const ctx = new FakeAudioContext();
    const { engine, detached } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    sounds.sync(new Map([['a', peer('a', 's1')]]), new Map([['a', { x: 1, y: 1 }]]), 1 / 60);
    sounds.peerLeft('a');
    expect(detached).toEqual(['scooter:a']);
    sounds.sync(new Map(), new Map(), 1 / 60);
    expect(detached).toEqual(['scooter:a']);
  });

  test('a rider moving at speed whines; a portal jump is no speed', () => {
    const ctx = new FakeAudioContext();
    const { engine } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    const peers = new Map([['a', peer('a', 's1')]]);
    const at = { x: 1, y: 1 };
    const positions = new Map([['a', at]]);
    sounds.sync(peers, positions, 1 / 60);
    at.x += 5;
    sounds.sync(peers, positions, 1 / 60);
    expect(level(ctx)).toBe(0);
    for (let i = 0; i < 60; i++) {
      at.x += 0.1;
      sounds.sync(peers, positions, 1 / 60);
    }
    expect(level(ctx)).toBeGreaterThan(0.5);
  });

  test('the own whine plays unplaced while riding and stops on stepping off', () => {
    const ctx = new FakeAudioContext();
    const { engine, unplaced } = fakeEngine();
    const sounds = createScooterSounds(asAudioContext(ctx), engine);
    sounds.own(3, true, true);
    sounds.own(4, true, true);
    expect(unplaced()).toBe(1);
    sounds.own(0, false, false);
    const saws = (ctx.byKind('oscillator') as unknown as { type: string; stoppedAt: number | null }[]).filter(
      (o) => o.type === 'sawtooth'
    );
    expect(saws.every((o) => o.stoppedAt !== null)).toBe(true);
  });
});
