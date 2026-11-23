import { LEVEL1, type Portals, parseMap, wirePortals } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import type { Lighting } from '../renderer/lighting';
import { createLightTimeline } from './light-timeline';

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
