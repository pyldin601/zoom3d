import type { PeerInfo } from '@zoom3d/shared';
import { beforeEach, expect, test, vi } from 'vitest';
import { createDoorbell, DOORBELL_COOLDOWN_S, DOORBELL_NOTES, withDoorbell } from './doorbell';
import { asAudioContext, FakeAudioContext, type FakeParam } from './fake-audio';

let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});

const oscillators = () =>
  ctx.byKind('oscillator') as unknown as { frequency: FakeParam; startedAt: number; stoppedAt: number }[];

test('rings a falling ding-dong straight to the speakers, not through the spatial graph', () => {
  createDoorbell(asAudioContext(ctx)).ring();
  const [ding, dong] = DOORBELL_NOTES;
  expect(ding?.hz).toBeGreaterThan(dong?.hz ?? Number.POSITIVE_INFINITY);
  const fundamentals = oscillators().filter((o) => DOORBELL_NOTES.some((n) => n.hz === o.frequency.value));
  expect(fundamentals.map((o) => [o.frequency.value, o.startedAt])).toEqual([
    [ding?.hz, ctx.currentTime + (ding?.at ?? 0)],
    [dong?.hz, ctx.currentTime + (dong?.at ?? 0)],
  ]);
  for (const o of oscillators()) {
    expect(o.stoppedAt).toBeGreaterThan(o.startedAt);
  }
  expect(ctx.byKind('panner')).toHaveLength(0);
  expect(ctx.byKind('gain').some((g) => g.connections.includes(ctx.destination))).toBe(true);
});

test('a burst of arrivals rings once per cooldown', () => {
  const bell = createDoorbell(asAudioContext(ctx));
  bell.ring();
  const perRing = oscillators().length;
  ctx.currentTime += DOORBELL_COOLDOWN_S / 2;
  bell.ring();
  expect(oscillators()).toHaveLength(perRing);
  ctx.currentTime += DOORBELL_COOLDOWN_S;
  bell.ring();
  expect(oscillators()).toHaveLength(perRing * 2);
});

test('rings for whoever arrives: another peer, or us on a fresh slot, but not when we resume ours', () => {
  const inner = { welcome: vi.fn(), peerJoined: vi.fn(), peerLeft: vi.fn() };
  const bell = { ring: vi.fn() };
  const listener = withDoorbell(inner, bell);
  const peer = { id: 'b' } as PeerInfo;

  listener.welcome?.('a', [], true);
  expect(inner.welcome).toHaveBeenCalledWith('a', [], true);
  expect(bell.ring).toHaveBeenCalledTimes(1);

  listener.welcome?.('a', [], false);
  expect(inner.welcome).toHaveBeenCalledTimes(2);
  expect(bell.ring).toHaveBeenCalledTimes(1);

  listener.peerJoined?.(peer);
  expect(inner.peerJoined).toHaveBeenCalledWith(peer);
  expect(bell.ring).toHaveBeenCalledTimes(2);

  listener.peerLeft?.('b');
  expect(inner.peerLeft).toHaveBeenCalledWith('b');
  expect(bell.ring).toHaveBeenCalledTimes(2);
});
