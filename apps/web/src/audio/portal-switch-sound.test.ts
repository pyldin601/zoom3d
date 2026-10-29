import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AudioEngine } from './engine';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createPortalSwitchSounds, SWITCH_SOUND_GAIN } from './portal-switch-sound';

type Source = FakeNode & { type: string; frequency: FakeParam; startedAt: number | null; stoppedAt: number | null };
type Filter = FakeNode & { type: string; frequency: FakeParam; Q: FakeParam };
type Convolver = FakeNode & { buffer: { length: number } };
type Gain = FakeNode & { gain: FakeParam };

let ctx: FakeAudioContext;
let played: FakeNode[];
beforeEach(() => {
  vi.useFakeTimers();
  ctx = new FakeAudioContext();
  played = [];
});
afterEach(() => vi.useRealTimers());

const engine = {
  playUnplaced(node: AudioNode) {
    played.push(node as unknown as FakeNode);
  },
} as unknown as AudioEngine;

const sounds = () => createPortalSwitchSounds(asAudioContext(ctx), engine);
const nodesSince = (count: number) => ctx.nodes.slice(count);
/** What `node` feeds first. */
const into = <T>(node: FakeNode | undefined) => node?.connections.at(0) as T;
const ofKind = <T>(nodes: FakeNode[], kind: string) => nodes.filter((n) => n.kind === kind) as unknown as T[];
/** The sketch schedules every sound 20 ms ahead of the cue. */
const startsAt = () => ctx.currentTime + 0.02;

/** Plays one sound and returns the nodes it built, checking it reaches the engine through its own reverb. */
function play(which: 'lightsOff' | 'portalsOn' | 'lightsOn', level: number, tailS: number, wet: number) {
  const s = sounds();
  const before = ctx.nodes.length;
  s[which]();
  const nodes = nodesSince(before);
  expect(played).toHaveLength(1);
  const mix = played.at(0) as FakeNode;
  const [convolver] = ofKind<Convolver>(nodes, 'convolver');
  expect(convolver?.buffer.length).toBe(Math.floor(tailS * ctx.sampleRate));
  const output = ofKind<Gain>(nodes, 'gain').find((g) => g.connections.includes(convolver as FakeNode));
  expect(output?.gain.value).toBeCloseTo(level * SWITCH_SOUND_GAIN);
  expect(output?.connections).toContain(mix);
  const wetGain = into<Gain>(convolver);
  expect(wetGain.gain.value).toBe(wet);
  expect(wetGain.connections).toEqual([mix]);
  expect(ctx.byKind('panner')).toHaveLength(0);
  return nodes;
}

/** Every node the sound built is disconnected once its last source and reverb tail are over, and not before. */
function expectReleasedAfter(nodes: FakeNode[], seconds: number) {
  vi.advanceTimersByTime(seconds * 1000 - 50);
  expect(nodes.some((n) => n.disconnected)).toBe(false);
  vi.advanceTimersByTime(100);
  expect(nodes.every((n) => n.disconnected)).toBe(true);
}

test('the master scale keeps the switch sounds well under voices', () => {
  expect(SWITCH_SOUND_GAIN).toBe(0.25);
});

test('lights off: a sine falling 90 → 32 Hz over 1.2 s and a low thunk, with a 3.5 s reverb', () => {
  const nodes = play('lightsOff', 0.8, 3.5, 0.55);
  const t = startsAt();
  const [body] = ofKind<Source>(nodes, 'oscillator');
  expect(body?.type).toBe('sine');
  expect(body?.frequency.events).toEqual([
    ['set', 90, t],
    ['exponential', 32, t + 1.2],
  ]);
  expect(body?.startedAt).toBe(t);
  expect(body?.stoppedAt).toBeCloseTo(t + 1.25);
  const bodyGain = into<Gain>(body);
  expect(bodyGain.gain.events).toEqual([
    ['set', 0, t],
    ['linear', 1, t + 0.01],
    ['exponential', 0.001, t + 1.2],
  ]);
  const [thunk] = ofKind<Source>(nodes, 'buffer-source');
  const lowpass = into<Filter>(thunk);
  expect(lowpass.type).toBe('lowpass');
  expect(lowpass.frequency.value).toBe(260);
  expect(into<Gain>(lowpass).gain.events).toEqual([
    ['set', 0.9, t],
    ['exponential', 0.001, t + 0.35],
  ]);
  expect(thunk?.stoppedAt).toBeCloseTo(t + 0.4);
  expectReleasedAfter(nodes, 0.02 + 1.25 + 3.5);
});

test('portals on: a sine rising 140 → 520 Hz over 0.7 s over a filtered 100 Hz buzz, with a 1.2 s reverb', () => {
  const nodes = play('portalsOn', 0.45, 1.2, 0.3);
  const t = startsAt();
  const [tone, buzz] = ofKind<Source>(nodes, 'oscillator');
  expect(tone?.type).toBe('sine');
  expect(tone?.frequency.events).toEqual([
    ['set', 140, t],
    ['exponential', 520, t + 0.7],
  ]);
  expect(into<Gain>(tone).gain.events).toEqual([
    ['set', 0.0001, t],
    ['exponential', 0.6, t + 0.7 * 0.6],
    ['exponential', 0.001, t + 0.7 + 0.25],
  ]);
  expect(tone?.stoppedAt).toBeCloseTo(t + 1);
  expect(buzz?.type).toBe('sawtooth');
  expect(buzz?.frequency.value).toBe(100);
  const lowpass = into<Filter>(buzz);
  expect([lowpass.type, lowpass.frequency.value]).toEqual(['lowpass', 900]);
  const buzzGain = into<Gain>(lowpass).gain.events;
  expect(buzzGain.at(1)?.[1]).toBeCloseTo(0.0875);
  expect(buzzGain.at(1)?.[2]).toBeCloseTo(t + 0.7 * 0.7);
  expect(buzzGain.at(2)).toEqual(['exponential', 0.0001, t + 0.7 + 0.3]);
  expect(buzz?.stoppedAt).toBeCloseTo(t + 1.05);
  expectReleasedAfter(nodes, 0.02 + 1.05 + 1.2);
});

test('lights on: a click, three flicker ticks across 0.3 s and a mains hum, with a 1.5 s reverb', () => {
  const nodes = play('lightsOn', 0.5, 1.5, 0.35);
  const t = startsAt();
  const ticks = ofKind<Source>(nodes, 'buffer-source');
  expect(ticks).toHaveLength(4);
  expect(ticks.at(0)?.startedAt).toBe(t);
  for (const [i, tick] of ticks.entries()) {
    const bandpass = into<Filter>(tick);
    expect([bandpass.type, bandpass.frequency.value, bandpass.Q.value]).toEqual(['bandpass', 1600, 2]);
    const level = into<Gain>(bandpass).gain.events.at(0)?.[1] ?? 0;
    if (i === 0) {
      expect(level).toBe(1.6);
    } else {
      expect(level).toBeGreaterThanOrEqual(0.5);
      expect(level).toBeLessThanOrEqual(0.9);
      const evenly = t + (0.3 * i) / 4;
      expect(tick.startedAt).toBeGreaterThanOrEqual(evenly);
      expect(tick.startedAt).toBeLessThanOrEqual(evenly + 0.02);
    }
  }
  const [hum] = ofKind<Source>(nodes, 'oscillator');
  expect([hum?.type, hum?.frequency.value]).toEqual(['sawtooth', 100]);
  const lowpass = into<Filter>(hum);
  expect([lowpass.type, lowpass.frequency.value]).toEqual(['lowpass', 700]);
  const humGain = into<Gain>(lowpass).gain.events;
  expect(humGain.at(1)?.[1]).toBeCloseTo(0.045);
  expect(humGain.at(1)?.[2]).toBeCloseTo(t + 0.4);
  expect(humGain.at(2)?.[2]).toBeCloseTo(t + 1.5);
  expect(hum?.stoppedAt).toBeCloseTo(t + 1.6);
  expectReleasedAfter(nodes, 0.02 + 1.6 + 1.5);
});

test('the reverb impulses are built once, not on every play', () => {
  const s = sounds();
  const builtAt = ctx.nodes.length;
  s.lightsOff();
  s.lightsOff();
  const [first, second] = ofKind<Convolver>(nodesSince(builtAt), 'convolver');
  expect(first?.buffer).toBe(second?.buffer);
});

test('a context that is not running plays nothing, so no stale sound waits for it to resume', () => {
  const s = sounds();
  const built = ctx.nodes.length;
  for (const state of ['suspended', 'closed'] as const) {
    ctx.state = state;
    s.lightsOff();
    s.portalsOn();
    s.lightsOn();
  }
  expect(played).toEqual([]);
  expect(ctx.nodes).toHaveLength(built);
});
