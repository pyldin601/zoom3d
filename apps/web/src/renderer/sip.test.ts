import { CHEERS_MS, SIP_MS } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { cheersPose, createGestureClock, sipPose } from './sip';

test('at rest outside a sip, including before any sip', () => {
  for (const t of [-1, SIP_MS, SIP_MS + 500, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(sipPose(t)).toBe(0);
  }
  expect(sipPose(0)).toBe(0);
});

test('held at the mouth from 350 ms to 1050 ms', () => {
  for (const t of [350, 700, 1050]) {
    expect(sipPose(t)).toBe(1);
  }
});

test('eased: halfway at the middle of each move', () => {
  expect(sipPose(175)).toBeCloseTo(0.5, 2);
  expect(sipPose(1225)).toBeCloseTo(0.5, 2);
});

test('rises steadily, then falls steadily', () => {
  for (let t = 0; t < 350; t += 10) {
    expect(sipPose(t + 10)).toBeGreaterThanOrEqual(sipPose(t));
  }
  for (let t = 1050; t < 1390; t += 10) {
    expect(sipPose(t + 10)).toBeLessThanOrEqual(sipPose(t));
  }
});

test('a gesture clock starts one sip at a time and can be cancelled', () => {
  const clock = createGestureClock();
  expect(clock.pose(0).sip).toBe(0);
  expect(clock.start('sip', 1000)).toBe(true);
  expect(clock.pose(1000 + 700).sip).toBe(1);
  expect(clock.start('sip', 1000 + SIP_MS - 1)).toBe(false);
  expect(clock.pose(1000 + 700).sip).toBe(1);
  expect(clock.start('sip', 1000 + SIP_MS)).toBe(true);
  clock.cancel();
  expect(clock.pose(1000 + SIP_MS + 700).sip).toBe(0);
  expect(clock.start('sip', 1000 + SIP_MS + 10)).toBe(true);
});

test('a cheers is down at the start and end, raised while held', () => {
  expect(cheersPose(-1).lift).toBe(0);
  expect(cheersPose(0).lift).toBe(0);
  expect(cheersPose(800).lift).toBe(1);
  expect(cheersPose(CHEERS_MS).lift).toBe(0);
  const rising = cheersPose(150).lift;
  expect(rising).toBeGreaterThan(0);
  expect(rising).toBeLessThan(1);
});

test('the wobble is still at rest and stays within ±1', () => {
  expect(cheersPose(-1).wobble).toBe(0);
  expect(cheersPose(CHEERS_MS).wobble).toBe(0);
  let moved = false;
  for (let t = 0; t <= CHEERS_MS; t += 10) {
    const { wobble } = cheersPose(t);
    expect(Math.abs(wobble)).toBeLessThanOrEqual(1);
    moved ||= Math.abs(wobble) > 0.5;
  }
  expect(moved).toBe(true);
});

test('a cheers and a sip never play together', () => {
  const clock = createGestureClock();
  expect(clock.start('cheers', 0)).toBe(true);
  expect(clock.kind(800)).toBe('cheers');
  expect(clock.start('sip', 1000)).toBe(false);
  expect(clock.start('sip', CHEERS_MS)).toBe(true);
  expect(clock.start('cheers', CHEERS_MS + 500)).toBe(false);
  clock.cancel();
  expect(clock.kind(CHEERS_MS + 600)).toBeNull();
  expect(clock.start('cheers', CHEERS_MS + 600)).toBe(true);
});

test('the pose shows only the playing gesture', () => {
  const clock = createGestureClock();
  clock.start('cheers', 0);
  const cheers = clock.pose(800);
  expect(cheers.sip).toBe(0);
  expect(cheers.cheers).toBe(1);
  clock.cancel();
  clock.start('sip', 0);
  const sip = clock.pose(700);
  expect(sip.sip).toBe(1);
  expect(sip.cheers).toBe(0);
  expect(sip.wobble).toBe(0);
});
