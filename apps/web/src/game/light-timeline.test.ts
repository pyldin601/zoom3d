import { LEVEL1, type Portals, parseMap, wirePortals } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import type { Lighting } from '../renderer/lighting';
import { createLightTimeline, createSeenPortals } from './light-timeline';

const lit = { lights: [{}] } as unknown as Lighting;
const dark = { lights: [] } as unknown as Lighting;
const portals = wirePortals(parseMap(LEVEL1), 'room') as Portals;

test('it keeps a change only when the lighting or the sight set changes', () => {
  const timeline = createLightTimeline();
  timeline.reset(0, lit, null);
  timeline.record(10, lit, null);
  timeline.record(20, dark, null);
  timeline.record(30, dark, portals);
  expect(timeline.count).toBe(3);
  expect(timeline.timeAt(0)).toBe(30);
  expect(timeline.lightingAt(1)).toBe(dark);
  expect(timeline.sightAt(0)).toBe(portals);
});

test('what was shown at a time: the newest change at or before it, the oldest before all', () => {
  const timeline = createLightTimeline();
  timeline.reset(100, lit, null);
  timeline.record(200, dark, null);
  expect(timeline.lightingSeenAt(150)).toBe(lit);
  expect(timeline.lightingSeenAt(250)).toBe(dark);
  expect(timeline.lightingSeenAt(0)).toBe(lit);
});

test('a change is still on its way while it is newer than the given time; a reset alone is none', () => {
  const timeline = createLightTimeline();
  timeline.reset(100, lit, null);
  expect(timeline.changedSince(0)).toBe(false);
  timeline.record(200, dark, null);
  expect(timeline.changedSince(150)).toBe(true);
  expect(timeline.changedSince(250)).toBe(false);
});

test('past its capacity the oldest changes go', () => {
  const timeline = createLightTimeline(4);
  timeline.reset(0, lit, null);
  for (let i = 1; i <= 6; i++) {
    timeline.record(i * 10, i % 2 ? dark : lit, null);
  }
  expect(timeline.count).toBe(4);
  expect(timeline.timeAt(3)).toBe(30);
});

test('each doorway opens when the change’s light reaches the eye from its plane, the nearer first', () => {
  const timeline = createLightTimeline();
  timeline.reset(0, lit, null);
  timeline.record(10_000, lit, portals);
  const eye = { x: 10.5, y: 10.5 };
  const distances = portals.list.map((p) => Math.hypot(p.cx - eye.x, p.cy - eye.y));
  const nearest = Math.min(...distances);
  const farthest = Math.max(...distances);
  const shown = createSeenPortals();
  expect(shown.update(timeline, eye, 10_000 + (nearest / 6) * 1000 - 10, 6)).toBeNull();
  const midway = 10_000 + ((nearest + farthest) / 2 / 6) * 1000;
  const some = shown.update(timeline, eye, midway, 6);
  distances.forEach((d, index) => {
    expect(some?.open?.[index]).toBe(d <= ((midway - 10_000) / 1000) * 6 ? 1 : 0);
  });
  expect(some?.list).toBe(portals.list);
  expect(shown.update(timeline, eye, 10_000 + (farthest / 6) * 1000 + 10, 6)).toBe(portals);
});

test('closing, each doorway shuts when its light arrives', () => {
  const timeline = createLightTimeline();
  timeline.reset(0, lit, portals);
  timeline.record(10_000, lit, null);
  const shown = createSeenPortals();
  const eye = { x: 10.5, y: 10.5 };
  expect(shown.update(timeline, eye, 10_001, 6)?.list).toBe(portals.list);
  expect(shown.update(timeline, eye, 60_000, 6)).toBeNull();
});
