import { parseMap } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { hexToRgb } from '../renderer/sprites';
import { createLocalPlayer } from './local-player';

const MAP = parseMap(['11111', '1...1', '1.S.1', '1...1', '11111'].join('\n'));
const STILL = { forward: 0, strafe: 0, turn: 0 };

test('taking a drink says whether it changed; putting it down ends the gesture', () => {
  const localPlayer = createLocalPlayer(MAP, () => 0.5);
  expect(localPlayer.takeDrink('beer')).toBe(true);
  expect(localPlayer.takeDrink('beer')).toBe(false);
  localPlayer.gesture.start('cheers', 0);
  expect(localPlayer.takeDrink(null)).toBe(true);
  expect(localPlayer.gesture.kind(1)).toBeNull();
  expect(localPlayer.drink).toBeNull();
});

test('walking turns the player and moves them', () => {
  const localPlayer = createLocalPlayer(MAP, () => 0.5);
  const { x, angle } = localPlayer.pose;
  localPlayer.walk(MAP, STILL, 0.5, 0.016);
  expect(localPlayer.pose.angle).toBeCloseTo(angle + 0.5);
  localPlayer.pose.angle = 0;
  localPlayer.walk(MAP, { forward: 1, strafe: 0, turn: 0 }, 0, 0.1);
  expect(localPlayer.pose.x).toBeGreaterThan(x);
});

test('the glow: none without a ring colour, the ring without a camera, the camera when it shows', () => {
  const localPlayer = createLocalPlayer(MAP, () => 0.5);
  expect(localPlayer.glow(0, null)).toBeNull();
  expect(localPlayer.glow(0, '#ff0000')).toMatchObject({
    x: localPlayer.pose.x,
    y: localPlayer.pose.y,
    color: hexToRgb('#ff0000'),
  });
  localPlayer.useCameraColour(() => 123);
  expect(localPlayer.glow(0, '#ff0000')?.color).toBe(123);
});

test('first person shows the drink and boombox in hand, mid-gesture', () => {
  const localPlayer = createLocalPlayer(MAP, () => 0.5);
  localPlayer.takeDrink('wine');
  localPlayer.boombox = true;
  localPlayer.gesture.start('sip', 0);
  expect(localPlayer.firstPerson(700)).toMatchObject({
    drink: 'wine',
    boombox: true,
    step: localPlayer.step,
    gesture: { sip: 1 },
  });
});
