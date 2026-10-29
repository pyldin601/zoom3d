import { beforeEach, describe, expect, test } from 'vitest';
import { portalHall } from '../renderer/test-portals';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createPortalHums, HUM_GAIN, type PortalHums, portalHumKey } from './portal-hum';

// Portal glow spec §2.5: one hum per doorway while portals are on, swelling with the glow's pulse.
type FakeOscillator = FakeNode & {
  type: OscillatorType;
  frequency: FakeParam;
  stoppedAt: number | null;
  onended: (() => void) | null;
};

let ctx: FakeAudioContext;
let attached: string[];
let detached: string[];
let outputs: Map<string, FakeNode & { gain: FakeParam }>;
let hums: PortalHums;
const { portals } = portalHall();

beforeEach(() => {
  ctx = new FakeAudioContext();
  attached = [];
  detached = [];
  outputs = new Map();
  hums = createPortalHums(asAudioContext(ctx), {
    attachNode(key, node) {
      attached.push(key);
      outputs.set(key, node as unknown as FakeNode & { gain: FakeParam });
    },
    detach(key) {
      detached.push(key);
    },
  });
});

const oscillators = () => ctx.byKind('oscillator') as unknown as FakeOscillator[];
const endEveryOscillator = () => {
  for (const o of oscillators()) {
    o.onended?.();
  }
};

describe('createPortalHums', () => {
  test('HUM_GAIN is at least 12 dB under unity, so it sits below voices', () => {
    expect(20 * Math.log10(HUM_GAIN)).toBeLessThanOrEqual(-12);
  });

  test('portals on attaches one hum per portal, each once', () => {
    hums.sync(portals, 1);
    hums.sync(portals, 1);
    expect(attached).toEqual([portalHumKey(0), portalHumKey(1)]);
    expect(portalHumKey(1)).toBe('portal-hum:1');
  });

  test('each hum is a 98 Hz sine and a 147 Hz triangle, fading in to HUM_GAIN', () => {
    hums.sync(portals, 1);
    const tones = oscillators().map((o) => [o.type, o.frequency.value]);
    expect(tones).toEqual([
      ['sine', 98],
      ['triangle', 147],
      ['sine', 98],
      ['triangle', 147],
    ]);
    const output = outputs.get(portalHumKey(0));
    expect(output?.gain.last?.[0]).toBe(HUM_GAIN);
  });

  test('portals off attaches nothing', () => {
    hums.sync(null, 1);
    expect(attached).toEqual([]);
    expect(ctx.nodes).toEqual([]);
  });

  test('turning portals off fades every hum out and detaches it; on again attaches each once', () => {
    hums.sync(portals, 1);
    hums.sync(null, 1);
    expect(outputs.get(portalHumKey(0))?.gain.last?.[0]).toBe(0);
    expect(outputs.get(portalHumKey(1))?.gain.last?.[0]).toBe(0);
    expect(oscillators().every((o) => (o.stoppedAt ?? 0) > ctx.currentTime)).toBe(true);
    expect(detached).toEqual([]);

    endEveryOscillator();
    expect(detached).toEqual([portalHumKey(0), portalHumKey(1)]);

    hums.sync(portals, 1);
    hums.sync(portals, 1);
    expect(attached).toEqual([portalHumKey(0), portalHumKey(1), portalHumKey(0), portalHumKey(1)]);
  });

  test('a hum that ends after portals came back on leaves the new hum attached', () => {
    hums.sync(portals, 1);
    hums.sync(null, 1);
    hums.sync(portals, 1);
    endEveryOscillator();
    expect(detached).toEqual([]);
  });

  test('the swell follows the pulse', () => {
    hums.sync(portals, 1);
    hums.sync(portals, 0.7);
    const swells = ctx.byKind('gain').filter((g) => (g.gain as FakeParam).last?.[2] === 0.05);
    expect(swells).toHaveLength(2);
    for (const swell of swells) {
      expect((swell.gain as FakeParam).last?.[0]).toBe(0.7);
    }
  });

  test('a hum sits 0.3 in front of its doorway', () => {
    const out = new Map<string, { x: number; y: number }>();
    hums.sourcesOf(portals, out);
    expect(out.get(portalHumKey(0))).toEqual({ x: 2.5, y: 3.2 });
    expect(out.get(portalHumKey(1))?.x).toBeCloseTo(4.5);
    expect(out.get(portalHumKey(1))?.y).toBeCloseTo(3.8);
    const first = out.get(portalHumKey(0));
    hums.sourcesOf(portals, out);
    expect(out.get(portalHumKey(0))).toBe(first);
    hums.sourcesOf(null, out);
    expect(out.size).toBe(0);
  });

  test('dispose stops and detaches every hum', () => {
    hums.sync(portals, 1);
    hums.dispose();
    expect(detached).toEqual([portalHumKey(0), portalHumKey(1)]);
    expect(oscillators().every((o) => o.stoppedAt !== null)).toBe(true);
  });
});
