import { DEFAULT_AUDIO_SETTINGS } from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { portalHall } from '../renderer/test-portals';
import { asAudioContext, FakeAudioContext, type FakeNode, type FakeParam } from './fake-audio';
import { createPortalHums, HUM_GAIN, type PortalHums, portalHumKey } from './portal-hum';

// Portal glow spec §2.5: one hum per doorway in hearing range while portals are on, swelling with the glow's pulse.
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
const hall = portalHall();
/** The hall's doorways, both turned to face north, so a listener north of the wall is in front of both. */
const portals = {
  ...hall.portals,
  list: hall.portals.list.map((p) => ({ ...p, nx: 0, ny: 1 })),
};
const MAX_TILES = 10;
const LISTENER = { x: 0, y: 0 };
/** South of the wall row: behind both doorways. */
const BEHIND = { x: 0, y: 5 };
/** Where each doorway's hum is heard: `tiles` east of the listener, per portal. */
const heard = new Map<string, { x: number; y: number }>();
const hearAt = (...tiles: number[]) => {
  tiles.forEach((x, i) => {
    heard.set(portalHumKey(i), { x, y: 0 });
  });
  return heard;
};
const NEAR = hearAt(2, 3);

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
    settings: () => ({ ...DEFAULT_AUDIO_SETTINGS, max: MAX_TILES }),
  });
  hearAt(2, 3);
});

/** Syncs with the pulse at 1 and the hums heard `tiles` away. */
const syncHeardAt = (...tiles: number[]) => hums.sync(portals, 1, LISTENER, hearAt(...tiles));

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
    hums.sync(portals, 1, LISTENER, NEAR);
    hums.sync(portals, 1, LISTENER, NEAR);
    expect(attached).toEqual([portalHumKey(0), portalHumKey(1)]);
    expect(portalHumKey(1)).toBe('portal-hum:1');
  });

  test('each hum is a 98 Hz sine and a 147 Hz triangle, fading in to HUM_GAIN', () => {
    hums.sync(portals, 1, LISTENER, NEAR);
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
    hums.sync(null, 1, LISTENER, NEAR);
    expect(attached).toEqual([]);
    expect(ctx.nodes).toEqual([]);
  });

  test('turning portals off fades every hum out and detaches it; on again attaches each once', () => {
    hums.sync(portals, 1, LISTENER, NEAR);
    hums.sync(null, 1, LISTENER, NEAR);
    expect(outputs.get(portalHumKey(0))?.gain.last?.[0]).toBe(0);
    expect(outputs.get(portalHumKey(1))?.gain.last?.[0]).toBe(0);
    expect(oscillators().every((o) => (o.stoppedAt ?? 0) > ctx.currentTime)).toBe(true);
    expect(detached).toEqual([]);

    endEveryOscillator();
    expect(detached).toEqual([portalHumKey(0), portalHumKey(1)]);

    hums.sync(portals, 1, LISTENER, NEAR);
    hums.sync(portals, 1, LISTENER, NEAR);
    expect(attached).toEqual([portalHumKey(0), portalHumKey(1), portalHumKey(0), portalHumKey(1)]);
  });

  test('a hum that ends after portals came back on leaves the new hum attached', () => {
    hums.sync(portals, 1, LISTENER, NEAR);
    hums.sync(null, 1, LISTENER, NEAR);
    hums.sync(portals, 1, LISTENER, NEAR);
    endEveryOscillator();
    expect(detached).toEqual([]);
  });

  test('the swell follows the pulse', () => {
    hums.sync(portals, 1, LISTENER, NEAR);
    hums.sync(portals, 0.7, LISTENER, NEAR);
    const swells = ctx.byKind('gain').filter((g) => (g.gain as FakeParam).last?.[2] === 0.05);
    expect(swells).toHaveLength(2);
    for (const swell of swells) {
      expect((swell.gain as FakeParam).last?.[0]).toBe(0.7);
    }
  });

  test('a doorway beyond hearing range has no hum', () => {
    syncHeardAt(2, MAX_TILES + 5);
    expect(attached).toEqual([portalHumKey(0)]);
    expect(ctx.byKind('oscillator')).toHaveLength(2);
  });

  test('a doorway with no apparent position has no hum', () => {
    heard.clear();
    hums.sync(portals, 1, LISTENER, heard);
    expect(attached).toEqual([]);
  });

  test('walking into range attaches the hum once, fading in', () => {
    syncHeardAt(2, MAX_TILES + 0.5);
    expect(attached).toEqual([portalHumKey(0)]);
    syncHeardAt(2, MAX_TILES - 0.5);
    syncHeardAt(2, MAX_TILES - 1);
    expect(attached).toEqual([portalHumKey(0), portalHumKey(1)]);
    expect(outputs.get(portalHumKey(1))?.gain.last?.[0]).toBe(HUM_GAIN);
  });

  test('walking out of range fades the hum out, then detaches it', () => {
    syncHeardAt(2, 3);
    syncHeardAt(2, MAX_TILES + 2);
    expect(outputs.get(portalHumKey(1))?.gain.last?.[0]).toBe(0);
    expect(outputs.get(portalHumKey(0))?.gain.last?.[0]).toBe(HUM_GAIN);
    expect(detached).toEqual([]);
    endEveryOscillator();
    expect(detached).toEqual([portalHumKey(1)]);
    syncHeardAt(2, 3);
    expect(attached).toEqual([portalHumKey(0), portalHumKey(1), portalHumKey(1)]);
  });

  test('pacing about the edge of the range neither restarts nor fades the hum', () => {
    syncHeardAt(2, MAX_TILES - 0.2);
    for (let i = 0; i < 4; i++) {
      syncHeardAt(2, MAX_TILES + 0.8);
      syncHeardAt(2, MAX_TILES - 0.2);
    }
    expect(attached).toEqual([portalHumKey(0), portalHumKey(1)]);
    expect(outputs.get(portalHumKey(1))?.gain.last?.[0]).toBe(HUM_GAIN);
    expect(oscillators().every((o) => o.stoppedAt === null)).toBe(true);
  });

  test('a listener behind a doorway hears no hum from it', () => {
    hums.sync(portals, 1, BEHIND, NEAR);
    expect(attached).toEqual([]);
  });

  test('stepping behind a doorway fades its hum out; stepping back in front starts it again', () => {
    hums.sync(portals, 1, LISTENER, NEAR);
    hums.sync(portals, 1, BEHIND, NEAR);
    expect(outputs.get(portalHumKey(0))?.gain.last?.[0]).toBe(0);
    expect(outputs.get(portalHumKey(1))?.gain.last?.[0]).toBe(0);
    endEveryOscillator();
    hums.sync(portals, 1, LISTENER, NEAR);
    expect(attached).toEqual([portalHumKey(0), portalHumKey(1), portalHumKey(0), portalHumKey(1)]);
  });

  test('a hum sits 0.3 in front of its doorway', () => {
    const out = new Map<string, { x: number; y: number }>();
    hums.sourcesOf(hall.portals, out);
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
    hums.sync(portals, 1, LISTENER, NEAR);
    hums.dispose();
    expect(detached).toEqual([portalHumKey(0), portalHumKey(1)]);
    expect(oscillators().every((o) => o.stoppedAt !== null)).toBe(true);
  });
});
