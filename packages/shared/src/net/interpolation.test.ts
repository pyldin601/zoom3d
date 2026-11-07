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

  test('never blends into a jump: before it, the earlier pose holds', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, 0));
    b.push({ ...snap(100, 20), jump: true });
    const o = out();
    b.sample(50, o);
    expect(o.x).toBe(0);
    b.sample(99, o);
    expect(o.x).toBe(0);
    b.sample(100, o);
    expect(o.x).toBe(20);
  });

  test('blends again after a jump', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, 0));
    b.push({ ...snap(100, 20), jump: true });
    b.push(snap(200, 22));
    const o = out();
    b.sample(150, o);
    expect(o.x).toBe(21);
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

describe('speedBetween', () => {
  const walking = (speed: number, jumpAt = -1) => {
    const b = new SnapshotBuffer();
    for (let i = 0; i <= 20; i++) {
      const x = (jumpAt >= 0 && i >= jumpAt ? 100 : 0) + (speed * i * 66) / 1000;
      b.push(i === jumpAt ? { t: i * 66, x, y: 0, angle: 0, jump: true } : { t: i * 66, x, y: 0, angle: 0 });
    }
    return b;
  };

  test('is the path drawn over the window divided by its length', () => {
    expect(walking(6).speedBetween(330, 990)).toBeCloseTo(6);
  });

  test('a window ending between snapshots counts the part drawn so far', () => {
    expect(walking(6).speedBetween(100, 700)).toBeCloseTo(6);
  });

  test('a jump through a portal is no travel', () => {
    expect(walking(6, 10).speedBetween(330, 990)).toBeLessThan(6);
    expect(walking(6, 10).speedBetween(330, 990)).toBeGreaterThan(4);
  });

  test('an empty or backwards window is no speed', () => {
    expect(new SnapshotBuffer().speedBetween(0, 100)).toBe(0);
    expect(walking(6).speedBetween(500, 400)).toBe(0);
  });
});
