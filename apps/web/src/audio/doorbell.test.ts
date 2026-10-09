import { beforeEach, expect, test } from 'vitest';
import { createDoorbell, DOORBELL_COOLDOWN_S, DOORBELL_NOTES } from './doorbell';
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
