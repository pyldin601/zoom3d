import { expect, test } from 'vitest';
import { createOwnMotion } from './own-motion';

const DT = 1 / 60;

/** Moves `frames` steps at `speed` tiles/s heading `heading`, the eye facing `eye`, and returns the last motion. */
function walk(
  frames: number,
  speed: number,
  heading: number,
  eye: number,
  lightSpeed: number,
  motion = createOwnMotion()
) {
  let x = 10;
  let y = 10;
  let last = motion.update(x, y, eye, DT, lightSpeed);
  for (let i = 0; i < frames; i++) {
    x += Math.cos(heading) * speed * DT;
    y += Math.sin(heading) * speed * DT;
    last = motion.update(x, y, eye, DT, lightSpeed);
  }
  return { motion, last, x, y };
}

test('standing still has no motion', () => {
  expect(walk(30, 0, 0, 0, 12).last.beta).toBe(0);
});

test('walking forward at 3 tiles/s settles at a quarter of c, straight ahead', () => {
  const { last } = walk(60, 3, 0.3, 0.3, 12);
  expect(last.beta).toBeCloseTo(0.25, 2);
  expect(last.angle).toBeCloseTo(0, 3);
});

test('strafing right reads as motion to the right', () => {
  expect(walk(60, 3, 0.3 + Math.PI / 2, 0.3, 12).last.angle).toBeCloseTo(Math.PI / 2, 3);
});

test('turning the head turns the motion, not the speed', () => {
  const { last } = walk(60, 3, 0, 0.5, 12);
  expect(last.angle).toBeCloseTo(-0.5, 3);
  expect(last.beta).toBeCloseTo(0.25, 2);
});

test('a step through a portal is no speed', () => {
  const { motion, x, y } = walk(60, 3, 0, 0, 12);
  const after = motion.update(x + 20, y, 0, DT, 12);
  expect(after.beta).toBeCloseTo(0.25, 2);
});

test('riding at 6 tiles/s with c at 6 clamps at half', () => {
  const { last } = walk(60, 6, 0, 0, 6);
  expect(last.beta).toBe(0.5);
  expect(Number.isFinite(last.angle)).toBe(true);
});

test('reset forgets the speed', () => {
  const { motion, x, y } = walk(60, 3, 0, 0, 12);
  motion.reset();
  expect(motion.update(x, y, 0, DT, 12).beta).toBe(0);
});
