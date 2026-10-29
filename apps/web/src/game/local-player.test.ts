import { parseMap } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { twoDoorways } from '../../../../packages/shared/src/portals/test-doorways';
import { hexToRgb } from '../renderer/sprites';
import { createLocalPlayer, OWN_SPRITE_KEY } from './local-player';

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

test('the own disc: none without a ring colour, else at the pose with the camera face and what is in hand', () => {
  const localPlayer = createLocalPlayer(MAP, () => 0.5);
  expect(localPlayer.avatar(0, null)).toBeNull();
  expect(localPlayer.avatar(0, '#ff0000')).toMatchObject({
    key: OWN_SPRITE_KEY,
    x: localPlayer.pose.x,
    y: localPlayer.pose.y,
    color: hexToRgb('#ff0000'),
    face: null,
    held: null,
    boombox: false,
  });
  const face = new Uint32Array(4);
  localPlayer.useCameraFace(() => face);
  localPlayer.takeDrink('beer');
  localPlayer.boombox = true;
  localPlayer.gesture.start('sip', 0);
  const disc = localPlayer.avatar(500, '#ff0000');
  expect(disc).toMatchObject({ face, held: 'beer', boombox: true, cheers: 0 });
  expect(disc?.sip).toBeGreaterThan(0);
  expect(localPlayer.avatar(600, '#ff0000')).toBe(disc);
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

test('walking south through doorway A comes out of B facing north, with portals', () => {
  const { map, portals } = twoDoorways();
  const localPlayer = createLocalPlayer(map, () => 0.5);
  Object.assign(localPlayer.pose, { x: 2.5, y: 3.4, angle: Math.PI / 2 });
  for (let i = 0; i < 10; i++) {
    localPlayer.walk(map, { forward: 1, strafe: 0, turn: 0 }, 0, 0.05, portals);
  }
  expect(localPlayer.pose.x).toBeCloseTo(4.5);
  expect(localPlayer.pose.y).toBeLessThan(3.5);
  expect(Math.sin(localPlayer.pose.angle)).toBeLessThan(-0.99);
});

test('the same walk without portals stays south of A', () => {
  const { map } = twoDoorways();
  const localPlayer = createLocalPlayer(map, () => 0.5);
  Object.assign(localPlayer.pose, { x: 2.5, y: 3.4, angle: Math.PI / 2 });
  for (let i = 0; i < 10; i++) {
    localPlayer.walk(map, { forward: 1, strafe: 0, turn: 0 }, 0, 0.05);
  }
  expect(localPlayer.pose.x).toBeCloseTo(2.5);
  expect(localPlayer.pose.y).toBeGreaterThan(3.5);
});
