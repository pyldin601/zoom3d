import { type ObjectInfo, parseMap, SnapshotBuffer } from '@zoom3d/shared';
import { beforeEach, expect, test } from 'vitest';
import { objectKey, type RemoteObject } from '../net/session';
import { createAudioEngine } from './engine';
import { asAudioContext, FakeAudioContext, type FakeParam } from './fake-audio';
import { createObjectSounds } from './object-sounds';

// Robot vacuum spec §5.4: one hum per vacuum, started and stopped with the room's objects.
const MAP = parseMap('1111111\n1.....1\n1.....1\n1S....1\n1111111');
let ctx: FakeAudioContext;
beforeEach(() => {
  ctx = new FakeAudioContext();
});

const object = (id: string): RemoteObject => ({
  info: { id, kind: 'vacuum', x: 2.5, y: 2.5, angle: 0 } as ObjectInfo,
  buffer: new SnapshotBuffer(),
  lastSeq: -1,
});
const setup = () => {
  const engine = createAudioEngine({ ctx: asAudioContext(ctx), map: MAP });
  return { engine, sounds: createObjectSounds(asAudioContext(ctx), engine) };
};
const motors = () => ctx.byKind('oscillator').filter((o) => o.type === 'triangle');
const motorHz = () => (motors()[0] as unknown as { frequency: FakeParam }).frequency;

test('sync starts one hum per vacuum, spatialised under objectKey(id)', () => {
  const { engine, sounds } = setup();
  const objects = new Map([['v', object('v')]]);
  const poses = new Map([[objectKey('v'), { x: 2.5, y: 2.5, angle: 0 }]]);
  sounds.sync(objects, poses, 0.016);
  sounds.sync(objects, poses, 0.016);
  expect(motors()).toHaveLength(1);
  engine.update(0, { x: 1.5, y: 1.5, angle: 0 }, poses);
  expect((ctx.byKind('panner')[0] as unknown as { positionX: FakeParam }).positionX.value).toBe(2.5);
});

test('sync stops and detaches hums of objects that are gone', () => {
  const { sounds } = setup();
  sounds.sync(new Map([['v', object('v')]]), new Map(), 0.016);
  sounds.sync(new Map([['w', object('w')]]), new Map(), 0.016);
  const [first, second] = motors();
  expect(first?.stoppedAt).not.toBeNull();
  expect(second?.stoppedAt).toBeNull();
  expect(ctx.byKind('panner')[0]?.disconnected).toBe(true);
});

test('an event reaches that object’s hum', () => {
  const { sounds } = setup();
  sounds.sync(new Map([['v', object('v')]]), new Map(), 0.016);
  sounds.event('v', 'bump');
  sounds.event('nobody', 'lost');
  expect(ctx.byKind('oscillator').filter((o) => (o.frequency as FakeParam).value === 70)).toHaveLength(1);
});

test('the hum follows the robot’s motion from pose to pose', () => {
  const { sounds } = setup();
  const objects = new Map([['v', object('v')]]);
  const key = objectKey('v');
  sounds.sync(objects, new Map([[key, { x: 2.5, y: 2.5, angle: 0 }]]), 0.1);
  sounds.sync(objects, new Map([[key, { x: 2.5, y: 2.5, angle: 0.2 }]]), 0.1);
  expect(motorHz().last?.[0]).toBe(99);
  sounds.sync(objects, new Map([[key, { x: 2.6, y: 2.5, angle: 0.2 }]]), 0.1);
  expect(motorHz().last?.[0]).toBe(110);
});

// Ball spec §6: the ball has no hum; its kicks and bounces play once each.
const ballObject = (id: string): RemoteObject => ({
  info: { id, kind: 'ball', x: 2.5, y: 2.5, angle: 0 },
  buffer: new SnapshotBuffer(),
  lastSeq: -1,
});
const thumps = () => ctx.byKind('oscillator').filter((o) => (o.frequency as FakeParam).value === 90);
const taps = () => ctx.byKind('oscillator').filter((o) => (o.frequency as FakeParam).value === 140);
const ballSetup = () => {
  const engine = createAudioEngine({ ctx: asAudioContext(ctx), map: MAP });
  const sounds = createObjectSounds(asAudioContext(ctx), engine, () => 'me');
  sounds.sync(new Map([['b', ballObject('b')]]), new Map(), 0.016);
  return sounds;
};

test('a ball gets no hum', () => {
  ballSetup();
  expect(motors()).toHaveLength(0);
});

test("someone else's kick and the vacuum's play the ball's thump", () => {
  const sounds = ballSetup();
  sounds.event('b', 'kick', 'other');
  sounds.event('b', 'kick');
  expect(thumps()).toHaveLength(2);
});

test("the local player's own kick echo is not played again", () => {
  const sounds = ballSetup();
  sounds.event('b', 'kick', 'me');
  expect(thumps()).toHaveLength(0);
});

test("the server's bounces are left to the local ball, which plays its own", () => {
  const sounds = ballSetup();
  sounds.event('b', 'bounce');
  expect(taps()).toHaveLength(0);
  sounds.localEvent('b', 'bounce');
  sounds.localEvent('b', 'kick');
  expect(taps()).toHaveLength(1);
  expect(thumps()).toHaveLength(1);
});
