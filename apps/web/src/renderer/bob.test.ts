import { MOVE_SPEED } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { BOB_STRIDE, createBob } from './bob';

/** Walks `dist` tiles along x in steps of `step` tiles, 1/60 s apart. */
function walk(bob: ReturnType<typeof createBob>, from: number, dist: number, step = 0.05) {
  let x = from;
  for (let d = 0; d < dist - 1e-9; d += step) {
    x += step;
    bob.update(x, 0, 1 / 60);
  }
  return x;
}

test('standing still never lifts', () => {
  const bob = createBob();
  for (let i = 0; i < 60; i++) {
    bob.update(1, 1, 1 / 60);
  }
  expect(bob.lift).toBe(0);
  expect(bob.itemLift).toBe(0);
});

test('the first sample only places the tracker (no jump from the origin)', () => {
  const bob = createBob();
  bob.update(10, 10, 1 / 60);
  expect(bob.lift).toBe(0);
});

test('lift peaks after half a stride and is back down after a whole one', () => {
  const bob = createBob();
  bob.update(0, 0, 1 / 60);
  walk(bob, 0, BOB_STRIDE / 2);
  expect(bob.lift).toBeGreaterThan(0.9);
  walk(bob, BOB_STRIDE / 2, BOB_STRIDE / 2);
  expect(bob.lift).toBeLessThan(0.1);
});

test('the drink lags behind the avatar', () => {
  const bob = createBob();
  bob.update(0, 0, 1 / 60);
  walk(bob, 0, BOB_STRIDE / 2);
  expect(bob.itemLift).toBeLessThan(bob.lift);
  walk(bob, BOB_STRIDE / 2, BOB_STRIDE / 4);
  expect(bob.itemLift).toBeGreaterThan(bob.lift);
});

test('after stopping, the lift eases down to 0 within 200 ms', () => {
  const bob = createBob();
  bob.update(0, 0, 1 / 60);
  const x = walk(bob, 0, BOB_STRIDE / 2);
  bob.update(x, 0, 1 / 60);
  expect(bob.lift).toBeGreaterThan(0.5);
  for (let i = 0; i < 12; i++) {
    bob.update(x, 0, 1 / 60);
  }
  expect(bob.lift).toBe(0);
  expect(bob.itemLift).toBe(0);
});

test('a teleport (resume, correction) does not count as walking', () => {
  const bob = createBob();
  bob.update(0, 0, 1 / 60);
  bob.update(5, 5, 1 / 60);
  expect(bob.lift).toBe(0);
});

test('sway swings to one side and back to the other over a stride', () => {
  const bob = createBob();
  bob.update(0, 0, 1 / 60);
  const x = walk(bob, 0, BOB_STRIDE / 2);
  expect(bob.sway).toBeGreaterThan(0.9);
  walk(bob, x, BOB_STRIDE);
  expect(bob.sway).toBeLessThan(-0.9);
});

test('at full walking speed a step takes 0.8 s: top of the step at 0.4 s, down again at 0.8 s', () => {
  const bob = createBob();
  bob.update(0, 0, 1 / 60);
  const perFrame = MOVE_SPEED / 60;
  let x = 0;
  for (let i = 0; i < 24; i++) {
    x += perFrame;
    bob.update(x, 0, 1 / 60);
  }
  expect(bob.lift).toBeGreaterThan(0.95);
  for (let i = 0; i < 24; i++) {
    x += perFrame;
    bob.update(x, 0, 1 / 60);
  }
  expect(bob.lift).toBeLessThan(0.1);
});
