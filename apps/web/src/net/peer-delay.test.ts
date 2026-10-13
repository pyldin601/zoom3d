import { FANOUT_TICK_MS, INTERP_DELAY_MS, NEAR_TILES, SnapshotBuffer } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { FAR_DELAY_MS, holdBefore, nearTier, PeerDelay, tierInterval } from './peer-delay';

describe('nearTier', () => {
  test('a tile inside the server line counts as near, anything beyond as far', () => {
    expect(nearTier(0, 0, NEAR_TILES - 1, 0)).toBe(true);
    expect(nearTier(0, 0, 0, NEAR_TILES - 1.01)).toBe(true);
    expect(nearTier(0, 0, NEAR_TILES - 0.99, 0)).toBe(false);
    expect(nearTier(0, 0, NEAR_TILES + 5, 0)).toBe(false);
  });
});

describe('PeerDelay', () => {
  test('starts at its tier at once', () => {
    expect(new PeerDelay().update(1000, true)).toBe(INTERP_DELAY_MS);
    expect(new PeerDelay().update(1000, false)).toBe(FAR_DELAY_MS);
  });

  test('moves toward a new tier at most half a millisecond per millisecond, both ways', () => {
    const d = new PeerDelay();
    d.update(0, true);
    expect(d.update(100, false)).toBe(INTERP_DELAY_MS + 50);
    expect(d.update(200, false)).toBe(INTERP_DELAY_MS + 100);
    expect(d.update(10_000, false)).toBe(FAR_DELAY_MS);
    expect(d.update(10_100, true)).toBe(FAR_DELAY_MS - 50);
    expect(d.update(20_000, true)).toBe(INTERP_DELAY_MS);
  });

  test('so the drawn time never runs backwards while the delay grows', () => {
    const d = new PeerDelay();
    let drawn = 0 - d.update(0, true);
    for (let t = 16; t < 3000; t += 16) {
      const next = t - d.update(t, false);
      expect(next).toBeGreaterThanOrEqual(drawn);
      drawn = next;
    }
  });
});

describe('holdBefore', () => {
  test('after a pause, holds the last pose until one interval before the new update', () => {
    const b = new SnapshotBuffer();
    b.push({ t: 0, x: 1, y: 1, angle: 0 });
    holdBefore(b, 5000, 66);
    b.push({ t: 5000, x: 1.2, y: 1, angle: 0 });
    const out = { x: 0, y: 0, angle: 0 };
    b.sample(4900, out);
    // Without the hold the peer would already be 98% of the way there.
    expect(out.x).toBe(1);
    b.sample(5000 - 33, out);
    expect(out.x).toBeCloseTo(1.1, 5);
  });

  test('changes nothing for steady updates', () => {
    const b = new SnapshotBuffer();
    b.push({ t: 0, x: 1, y: 1, angle: 0 });
    holdBefore(b, 66, 66);
    b.push({ t: 66, x: 2, y: 1, angle: 0 });
    const out = { x: 0, y: 0, angle: 0 };
    b.sample(33, out);
    expect(out.x).toBeCloseTo(1.5, 5);
  });

  test('steady far updates (every 528 ms: the server skips at 462 and sends at 528) are never held', () => {
    expect(tierInterval(false)).toBe(528);
    const b = new SnapshotBuffer();
    for (let i = 0; i < 4; i++) {
      holdBefore(b, i * 528, tierInterval(false));
      b.push({ t: i * 528, x: i, y: 1, angle: 0 });
    }
    const out = { x: 0, y: 0, angle: 0 };
    b.sample(528 + 264, out);
    expect(out.x).toBeCloseTo(1.5, 5);
  });

  test('a near update a little late (jitter) is not held', () => {
    expect(tierInterval(true)).toBe(FANOUT_TICK_MS);
    const b = new SnapshotBuffer();
    b.push({ t: 0, x: 1, y: 1, angle: 0 });
    holdBefore(b, 110, tierInterval(true));
    b.push({ t: 110, x: 2, y: 1, angle: 0 });
    const out = { x: 0, y: 0, angle: 0 };
    b.sample(55, out);
    expect(out.x).toBeCloseTo(1.5, 5);
  });

  test('a near peer whose move was skipped (two moves in one server tick) is not held', () => {
    // Two client sends 66.7 ms apart land in one tick: the receiver sees a 133 ms gap while the peer never stopped.
    const b = new SnapshotBuffer();
    b.push({ t: 0, x: 1, y: 1, angle: 0 });
    holdBefore(b, 133, tierInterval(true));
    b.push({ t: 133, x: 3, y: 1, angle: 0 });
    const out = { x: 0, y: 0, angle: 0 };
    b.sample(66.5, out);
    expect(out.x).toBeCloseTo(2, 5);
  });

  test('does nothing on an empty buffer', () => {
    const b = new SnapshotBuffer();
    holdBefore(b, 1000, 66);
    expect(b.latest()).toBeNull();
  });
});
