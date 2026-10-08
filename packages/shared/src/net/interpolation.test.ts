import { describe, expect, test } from 'vitest';
import { SnapshotBuffer } from './interpolation';

const out = () => ({ x: 0, y: 0, angle: 0 });
const snap = (t: number, x: number, angle = 0) => ({ t, x, y: 0, angle });

describe('SnapshotBuffer', () => {
  test('interpolates between two snapshots', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, 0));
    b.push(snap(100, 10));
    const o = out();
    expect(b.sample(50, o)).toBe(true);
    expect(o.x).toBeCloseTo(5);
  });

  test('holds the ends instead of extrapolating', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, 0));
    b.push(snap(100, 10));
    const o = out();
    b.sample(-10, o);
    expect(o.x).toBe(0);
    b.sample(500, o);
    expect(o.x).toBe(10);
  });

  test('empty buffer reports nothing', () => {
    expect(new SnapshotBuffer().sample(0, out())).toBe(false);
    expect(new SnapshotBuffer().latest()).toBeNull();
  });

  test('ignores out-of-order snapshots', () => {
    const b = new SnapshotBuffer();
    b.push(snap(100, 10));
    b.push(snap(50, 99));
    expect(b.latest()).toEqual(snap(100, 10));
  });

  test('a snapshot with the same timestamp replaces the newest', () => {
    const b = new SnapshotBuffer();
    b.push(snap(100, 10));
    b.push(snap(100, 12));
    expect(b.latest()).toEqual(snap(100, 12));
  });

  test('angle takes the short way across 2π and stays wrapped', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, 0, 6.2));
    b.push(snap(100, 0, 0.1));
    const o = out();
    b.sample(50, o);
    expect(o.angle).toBeCloseTo(0.1 - (0.1 - 6.2 + 2 * Math.PI) / 2, 4);
    expect(o.angle).toBeGreaterThanOrEqual(0);
    expect(o.angle).toBeLessThan(2 * Math.PI);
  });

  test('drops the oldest when full', () => {
    const b = new SnapshotBuffer(2);
    b.push(snap(0, 0));
    b.push(snap(100, 10));
    b.push(snap(200, 20));
    const o = out();
    b.sample(0, o);
    expect(o.x).toBe(10);
  });
});
