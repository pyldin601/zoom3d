import { DEFAULT_AUDIO_SETTINGS, parseMap, voiceGains } from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { createAudioEngine, makeImpulse, speakingLevel } from './engine';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';

const OPEN = parseMap('1111111\n1.....1\n1.....1\n1S....1\n1111111');
const WALLED = parseMap('1111111\n1..1..1\n1..1..1\n1S.1..1\n1111111');
const stream = (id = 's', audio = true) =>
  ({ id, getAudioTracks: () => (audio ? [{ kind: 'audio' }] : []) }) as unknown as MediaStream;
const at = (x: number, y: number) => new Map([['b', { x, y }]]);
const listener = { x: 1.5, y: 1.5, angle: 0 };

let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});

const engine = (map = OPEN) => createAudioEngine({ ctx: asAudioContext(ctx), map });
const one = (kind: string) => ctx.byKind(kind).at(-1) as FakeNode & Record<string, FakeParam & unknown>;
const param = (kind: string, name: string) => one(kind)[name] as FakeParam;
const gains = () => ctx.byKind('gain').filter((g) => g.connections[0]?.kind !== 'destination');

describe('createAudioEngine', () => {
  test('a voice is wired source → lowpass → (dry → panner → out) + (send → reverb), with an analyser tap', () => {
    engine().attach('b', stream());
    const [source] = ctx.byKind('source');
    const filter = one('biquad');
    const panner = one('panner');
    const convolver = one('convolver');
    expect(source?.connections.map((n) => n.kind).sort()).toEqual(['analyser', 'biquad']);
    expect(filter.type).toBe('lowpass');
    const [dry, send] = filter.connections;
    expect(dry?.connections).toEqual([panner]);
    expect(panner.connections).toEqual([ctx.destination]);
    expect(send?.connections).toEqual([convolver]);
    expect(panner.rolloffFactor).toBe(0);
    expect(panner.distanceModel).toBe('linear');
    expect(panner.panningModel).toBe('HRTF');
    // Our impulse is unit energy; the browser's normalization would cost ~13 dB.
    expect(convolver.normalize).toBe(false);
  });

  test('update sets the listener, pans the voice and applies the distance curve', () => {
    const e = engine();
    e.attach('b', stream());
    e.update(0, listener, at(4.5, 1.5));
    expect(param('panner', 'positionX').value).toBe(4.5);
    expect(param('panner', 'positionZ').value).toBe(1.5);
    expect(ctx.listener.forwardX.value).toBeCloseTo(1);
    expect(ctx.listener.forwardZ.value).toBeCloseTo(0);
    const [dry] = one('biquad').connections as (FakeNode & { gain: FakeParam })[];
    expect(dry?.gain.last).toEqual([voiceGains(3, false, DEFAULT_AUDIO_SETTINGS).dry, ctx.currentTime, 0.05]);
  });

  test('a voice at the listener position stays finite', () => {
    const e = engine();
    e.attach('b', stream());
    e.update(0, listener, at(1.5, 1.5));
    for (const g of gains()) {
      expect(Number.isFinite((g.gain as FakeParam).value)).toBe(true);
    }
    expect(Number.isFinite(param('panner', 'positionX').value)).toBe(true);
  });

  test('a wall muffles and attenuates, re-checked at most every 100 ms', () => {
    const e = engine(WALLED);
    e.attach('b', stream());
    e.update(0, listener, at(2.5, 1.5));
    expect(param('biquad', 'frequency').targets).toEqual([]);
    e.update(50, listener, at(4.5, 1.5));
    expect(param('biquad', 'frequency').targets).toEqual([]);
    e.update(100, listener, at(4.5, 1.5));
    expect(param('biquad', 'frequency').last).toEqual([700, ctx.currentTime, 0.15]);
    const [dry] = one('biquad').connections as (FakeNode & { gain: FakeParam })[];
    expect(dry?.gain.last?.[0]).toBeCloseTo(voiceGains(3, true, DEFAULT_AUDIO_SETTINGS).dry);
    expect(dry?.gain.last?.[2]).toBe(0.15);
  });

  test('a voice with no known position is ramped to silence', () => {
    const e = engine();
    e.attach('b', stream());
    e.update(0, listener, new Map());
    const [dry, send] = one('biquad').connections as (FakeNode & { gain: FakeParam })[];
    expect(dry?.gain.last?.[0]).toBe(0);
    expect(send?.gain.last?.[0]).toBe(0);
  });

  test('detach and stream replacement disconnect the whole chain', () => {
    const e = engine();
    const one = stream('one');
    e.attach('b', one);
    const first = ctx.nodes.filter((n) => ['source', 'analyser', 'biquad', 'panner'].includes(n.kind));
    e.attach('b', one);
    expect(ctx.byKind('source')).toHaveLength(1);
    e.attach('b', stream('two'));
    expect(first.every((n) => n.disconnected)).toBe(true);
    expect(ctx.byKind('source')).toHaveLength(2);
    e.detach('b');
    expect(ctx.byKind('source').every((n) => n.disconnected)).toBe(true);
  });

  test('settings change panning and reverb level', () => {
    const e = engine();
    e.attach('b', stream());
    e.setSettings({ ...DEFAULT_AUDIO_SETTINGS, panning: 'equalpower', reverb: 0 });
    expect(one('panner').panningModel).toBe('equalpower');
    const reverbGain = ctx.byKind('gain').find((g) => g.connections[0] === ctx.destination);
    expect((reverbGain?.gain as FakeParam | undefined)?.last?.[0]).toBe(0);
    expect(e.settings().panning).toBe('equalpower');
  });

  test('a suspended context never makes update throw, and resume resumes it', async () => {
    ctx.state = 'suspended';
    const e = engine();
    e.attach('b', stream());
    expect(() => e.update(0, listener, at(3.5, 1.5))).not.toThrow();
    await e.resume();
    expect(ctx.resumes).toBe(1);
  });

  test('input level and speaking come from the analyser before any gain', () => {
    const e = engine();
    e.attach('b', stream());
    ctx.analyserData.fill(0.2);
    e.update(0, listener, at(20, 1.5));
    expect(e.inputLevel('b')).toBeCloseTo(0.2);
    expect(e.speaking('b')).toBe(1);
    expect(e.speaking('nobody')).toBe(0);
  });
});

describe('speakingLevel', () => {
  test('instant attack, exponential release, quiet floor', () => {
    expect(speakingLevel(0, 0.1, 0.016)).toBe(1);
    expect(speakingLevel(1, 0, 0.3)).toBeCloseTo(Math.exp(-1));
    expect(speakingLevel(0, 0.005, 0.016)).toBe(0);
  });
});

describe('makeImpulse', () => {
  test('stereo, 10 ms silent pre-delay, decaying tail', () => {
    const buffer = makeImpulse(asAudioContext(ctx)) as unknown as {
      numberOfChannels: number;
      length: number;
      getChannelData(c: number): Float32Array;
    };
    expect(buffer.numberOfChannels).toBe(2);
    expect(buffer.length).toBe(Math.round(0.81 * 48000));
    const data = buffer.getChannelData(0);
    expect(data.slice(0, 480).every((v) => v === 0)).toBe(true);
    const energy = (from: number, to: number) => data.slice(from, to).reduce((s, v) => s + v * v, 0);
    expect(energy(30000, 38000)).toBeLessThan(energy(480, 8480) / 100);
  });

  test('each channel has unit energy, so the reverb passes at 0 dB', () => {
    const buffer = makeImpulse(asAudioContext(ctx)) as unknown as { getChannelData(c: number): Float32Array };
    for (const ch of [0, 1]) {
      expect(buffer.getChannelData(ch).reduce((s, v) => s + v * v, 0)).toBeCloseTo(1, 5);
    }
  });
});

describe('review fixes', () => {
  const dryOf = () =>
    (one('biquad').connections as (FakeNode & { gain: FakeParam })[])[0] as FakeNode & { gain: FakeParam };

  test('a stream without audio tracks is ignored instead of throwing', () => {
    const e = engine();
    expect(() => e.attach('b', stream('video-only', false))).not.toThrow();
    expect(ctx.byKind('source')).toHaveLength(0);
    expect(() => e.update(0, listener, at(3.5, 1.5))).not.toThrow();
    expect(e.speaking('b')).toBe(0);
  });

  test('occlusion gain changes keep the slow time constant for a few frames, then return to normal', () => {
    const e = engine(WALLED);
    e.attach('b', stream());
    e.update(0, listener, at(2.5, 1.5));
    e.update(100, listener, at(4.5, 1.5));
    expect(dryOf().gain.last?.[2]).toBe(0.15);
    e.update(116, listener, at(4.5, 1.5));
    expect(dryOf().gain.last?.[2]).toBe(0.15);
    e.update(600, listener, at(4.5, 1.5));
    expect(dryOf().gain.last?.[2]).toBe(0.05);
  });

  test('a new voice and the listener jump to their first position instead of gliding from the origin', () => {
    const e = engine();
    e.attach('b', stream());
    e.update(0, listener, at(4.5, 1.5));
    const px = param('panner', 'positionX');
    expect(px.value).toBe(4.5);
    expect(px.targets).toEqual([]);
    expect(ctx.listener.positionX.value).toBe(1.5);
    expect(ctx.listener.positionX.targets).toEqual([]);
    e.update(16, listener, at(4.6, 1.5));
    expect(px.last?.[0]).toBe(4.6);
  });
});
