import { parseMap } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { hexToRgb } from '../renderer/sprites';
import { createYou } from './you';

const MAP = parseMap(['11111', '1...1', '1.S.1', '1...1', '11111'].join('\n'));
const STILL = { forward: 0, strafe: 0, turn: 0 };

test('taking a drink says whether it changed; putting it down ends the gesture', () => {
  const you = createYou(MAP, () => 0.5);
  expect(you.takeDrink('beer')).toBe(true);
  expect(you.takeDrink('beer')).toBe(false);
  you.gesture.start('cheers', 0);
  expect(you.takeDrink(null)).toBe(true);
  expect(you.gesture.kind(1)).toBeNull();
  expect(you.drink).toBeNull();
});

test('walking turns you and moves you', () => {
  const you = createYou(MAP, () => 0.5);
  const { x, angle } = you.player;
  you.walk(MAP, STILL, 0.5, 0.016);
  expect(you.player.angle).toBeCloseTo(angle + 0.5);
  you.player.angle = 0;
  you.walk(MAP, { forward: 1, strafe: 0, turn: 0 }, 0, 0.1);
  expect(you.player.x).toBeGreaterThan(x);
});

test('your glow: none without a ring colour, the ring without a camera, the camera when it shows', () => {
  const you = createYou(MAP, () => 0.5);
  expect(you.glow(0, null)).toBeNull();
  expect(you.glow(0, '#ff0000')).toMatchObject({ x: you.player.x, y: you.player.y, color: hexToRgb('#ff0000') });
  you.useCameraColour(() => 123);
  expect(you.glow(0, '#ff0000')?.color).toBe(123);
});

test('your hands hold your drink and boombox, mid-gesture', () => {
  const you = createYou(MAP, () => 0.5);
  you.takeDrink('wine');
  you.boombox = true;
  you.gesture.start('sip', 0);
  expect(you.hands(700)).toMatchObject({ drink: 'wine', boombox: true, step: you.step, gesture: { sip: 1 } });
});
