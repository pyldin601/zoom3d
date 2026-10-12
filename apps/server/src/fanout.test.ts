import { FAR_INTERVAL_MS, NEAR_TILES } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { type SentLog, type Subject, selectBatch } from './fanout';

const self = { id: 'me', x: 10, y: 10 };
const near = (over: Partial<Subject> = {}): Subject => ({
  id: 'n',
  slot: 1,
  x: 12,
  y: 10,
  angle: 0,
  poseVersion: 1,
  ...over,
});
const far = (over: Partial<Subject> = {}): Subject => ({
  id: 'f',
  slot: 2,
  x: 10 + NEAR_TILES + 1,
  y: 10,
  angle: 0,
  poseVersion: 1,
  ...over,
});

describe('selectBatch', () => {
  test('a changed near peer goes out on every call', () => {
    const sent: SentLog = new Map();
    const n = near();
    expect(selectBatch(self, [n], sent, 0)).toEqual([[1, 12, 10, 0]]);
    n.poseVersion++;
    n.x = 12.5;
    expect(selectBatch(self, [n], sent, 66)).toEqual([[1, 12.5, 10, 0]]);
  });

  test('an unchanged pose is never resent, near or far', () => {
    const sent: SentLog = new Map();
    const subjects = [near(), far()];
    expect(selectBatch(self, subjects, sent, 0)).toHaveLength(2);
    expect(selectBatch(self, subjects, sent, 66)).toEqual([]);
    expect(selectBatch(self, subjects, sent, 10_000)).toEqual([]);
  });

  test('a far peer goes out at most every FAR_INTERVAL_MS, with its latest pose', () => {
    const sent: SentLog = new Map();
    const f = far();
    expect(selectBatch(self, [f], sent, 0)).toHaveLength(1);
    for (let t = 66; t < FAR_INTERVAL_MS; t += 66) {
      f.poseVersion++;
      f.y += 0.1;
      expect(selectBatch(self, [f], sent, t)).toEqual([]);
    }
    f.poseVersion++;
    expect(selectBatch(self, [f], sent, FAR_INTERVAL_MS)).toEqual([[2, f.x, Math.round(f.y * 100) / 100, 0]]);
  });

  test('exactly NEAR_TILES away is near', () => {
    const sent: SentLog = new Map();
    const edge = near({ x: self.x, y: self.y + NEAR_TILES });
    selectBatch(self, [edge], sent, 0);
    edge.poseVersion++;
    expect(selectBatch(self, [edge], sent, 66)).toHaveLength(1);
  });

  test('the recipient is never in its own batch', () => {
    expect(selectBatch(self, [near({ id: 'me' })], new Map(), 0)).toEqual([]);
  });

  test('entries are rounded for the wire', () => {
    expect(selectBatch(self, [near({ x: 12.3456, y: 9.8765, angle: 1.23456 })], new Map(), 0)).toEqual([
      [1, 12.35, 9.88, 1.235],
    ]);
  });
});
