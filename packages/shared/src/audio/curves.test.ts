import { describe, expect, test } from 'vitest';
import { DEFAULT_AUDIO_SETTINGS as D, normalizeAudioSettings, voiceGains, WET_NEAR } from './curves';

describe('voiceGains', () => {
  test('full dry and near reverb within ref; silent from max', () => {
    expect(voiceGains(0, false, D)).toEqual({ dry: 1, send: WET_NEAR });
    expect(voiceGains(D.ref, false, D)).toEqual({ dry: 1, send: WET_NEAR });
    expect(voiceGains(D.max, false, D)).toEqual({ dry: 0, send: 0 });
    expect(voiceGains(50, false, D)).toEqual({ dry: 0, send: 0 });
  });

  test('silence is twice as far as it used to be', () => {
    expect(D.max).toBe(24);
  });

  test('before the fade, dry follows 1/d and send 1/√d', () => {
    const near = voiceGains(6, false, D);
    const far = voiceGains(12, false, D);
    expect(far.dry / near.dry).toBeCloseTo(0.5);
    expect(far.send / near.send).toBeCloseTo(Math.SQRT1_2);
  });

  test('both gains fall and the wet/dry ratio rises with distance', () => {
    let prev = voiceGains(D.ref, false, D);
    for (let d = D.ref + 0.5; d < D.max; d += 0.5) {
      const g = voiceGains(d, false, D);
      expect(g.dry).toBeLessThan(prev.dry);
      expect(g.send).toBeLessThan(prev.send);
      expect(g.send).toBeGreaterThan(0);
      expect(g.send / g.dry).toBeGreaterThan(prev.send / prev.dry);
      prev = g;
    }
  });

  test('occlusion scales both gains', () => {
    const open = voiceGains(3, false, D);
    const walled = voiceGains(3, true, D);
    expect(walled.dry).toBeCloseTo(open.dry * D.occludedGain);
    expect(walled.send).toBeCloseTo(open.send * D.occludedGain);
  });

  test('degenerate distances stay finite', () => {
    expect(voiceGains(0, true, D)).toEqual({ dry: 0.5, send: 0.2 });
    expect(voiceGains(Number.NaN, false, D)).toEqual({ dry: 0, send: 0 });
    expect(voiceGains(-1, false, D).dry).toBe(1);
  });
});

describe('normalizeAudioSettings', () => {
  test.each([null, {}, 'x', 42])('%s gives the defaults', (v) => {
    expect(normalizeAudioSettings(v)).toEqual(D);
  });

  test('max is kept above ref', () => {
    expect(normalizeAudioSettings({ ref: 5, max: 3 })).toMatchObject({ ref: 5, max: 5.5 });
  });

  test.each([
    [{ reverb: -1 }, 'reverb'],
    [{ reverb: Number.NaN }, 'reverb'],
    [{ muffleHz: 50 }, 'muffleHz'],
    [{ occludedGain: 2 }, 'occludedGain'],
    [{ panning: 'surround' }, 'panning'],
    [{ ref: '2' }, 'ref'],
  ])('invalid %o falls back for %s', (v, key) => {
    expect(normalizeAudioSettings(v)[key as keyof typeof D]).toEqual(D[key as keyof typeof D]);
  });

  test('valid custom values are preserved', () => {
    const custom = { ref: 2, max: 20, reverb: 0.5, muffleHz: 1200, occludedGain: 0.3, panning: 'equalpower' };
    expect(normalizeAudioSettings(custom)).toEqual(custom);
  });
});
