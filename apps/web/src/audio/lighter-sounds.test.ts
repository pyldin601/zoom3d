import { describe, expect, test } from 'vitest';
import type { AudioEngine } from './engine';
import { asAudioContext, FakeAudioContext } from './fake-audio';
import { createLighterSounds } from './lighter-sounds';

/** An engine that only records what is attached, detached and played unplaced. */
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

describe('createLighterSounds', () => {
  test("a peer lighting a lighter is heard from that peer's spot", () => {
    const ctx = new FakeAudioContext();
    const { engine, attached } = fakeEngine();
    createLighterSounds(asAudioContext(ctx), engine).peerHeld('a', 'beer', 'lighter');
    expect([...attached]).toEqual([['lighter:a', 'a']]);
    expect(ctx.byKind('buffer-source')).toHaveLength(1);
  });

  test('putting it away snaps the lid; changing one drink for another is silent', () => {
    const ctx = new FakeAudioContext();
    const { engine } = fakeEngine();
    const sounds = createLighterSounds(asAudioContext(ctx), engine);
    sounds.peerHeld('a', 'beer', 'coffee');
    expect(ctx.byKind('oscillator')).toHaveLength(0);
    sounds.peerHeld('a', 'lighter', null);
    expect(ctx.byKind('oscillator').length).toBeGreaterThan(0);
    expect(ctx.byKind('buffer-source')).toHaveLength(0);
  });

  test('a peer who leaves has their lighter sound detached', () => {
    const ctx = new FakeAudioContext();
    const { engine, attached, detached } = fakeEngine();
    const sounds = createLighterSounds(asAudioContext(ctx), engine);
    sounds.peerHeld('a', null, 'lighter');
    sounds.peerLeft('a');
    expect(attached.size).toBe(0);
    expect(detached).toContain('lighter:a');
  });

  test("the local player's own lighter is heard unplaced, wired up once", () => {
    const ctx = new FakeAudioContext();
    const fake = fakeEngine();
    const sounds = createLighterSounds(asAudioContext(ctx), fake.engine);
    sounds.own(null, 'lighter');
    sounds.own('lighter', null);
    sounds.own('wine', 'beer');
    expect(fake.unplaced()).toBe(1);
    expect(ctx.byKind('buffer-source')).toHaveLength(1);
  });
});
