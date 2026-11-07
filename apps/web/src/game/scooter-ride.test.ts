import { type ObjectInfo, SnapshotBuffer } from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { objectKey, type RemoteObject } from '../net/session';
import { createScooterRide, type RideSession } from './scooter-ride';

const scooter = (id: string, x: number): RemoteObject => ({
  info: { id, kind: 'scooter', x, y: 0, angle: 0 } satisfies ObjectInfo,
  buffer: new SnapshotBuffer(),
  lastSeq: -1,
});

let time: number;
let sentMessages: string[];
let session: RideSession & { riding: string | null };

beforeEach(() => {
  time = 0;
  sentMessages = [];
  session = {
    riding: null,
    objects: new Map([
      ['far', scooter('far', 0.9)],
      ['near', scooter('near', 0.6)],
      ['vacuum', { ...scooter('vacuum', 0.1), info: { id: 'vacuum', kind: 'vacuum', x: 0.1, y: 0, angle: 0 } }],
    ]),
    sendRide: (id) => sentMessages.push(`ride ${id}`),
    sendDismount: () => sentMessages.push('dismount'),
  };
});

const ride = () => createScooterRide(session, () => time);
const player = { x: 0, y: 0 };

describe('toggle', () => {
  test('on foot it asks for the nearest scooter in reach, never another object', () => {
    ride().toggle(player);
    expect(sentMessages).toEqual(['ride near']);
  });

  test('with nothing in reach it asks for nothing', () => {
    ride().toggle({ x: -1.2, y: 0 });
    expect(sentMessages).toEqual([]);
  });

  test('a scooter is measured where it appeared to the local player in the last frame', () => {
    const apparent = new Map([[objectKey('far'), { x: 0.2, y: 0 }]]);
    const r = ride();
    r.inReach(player, apparent);
    r.toggle(player);
    expect(sentMessages).toEqual(['ride far']);
  });

  test('while an answer is pending another press does nothing', () => {
    const r = ride();
    r.toggle(player);
    r.toggle(player);
    expect(sentMessages).toEqual(['ride near']);
  });

  test('once the ride is settled the next press steps off', () => {
    const r = ride();
    r.toggle(player);
    session.riding = 'near';
    r.settled();
    r.toggle(player);
    expect(sentMessages).toEqual(['ride near', 'dismount']);
  });

  test('with no answer within a second a press asks again', () => {
    const r = ride();
    r.toggle(player);
    time += 1000;
    r.toggle(player);
    expect(sentMessages).toEqual(['ride near', 'ride near']);
  });
});

describe('speed and reach', () => {
  test('a scooter is in reach only on foot, with nothing pending', () => {
    const r = ride();
    expect(r.inReach(player)).toBe(true);
    expect(r.inReach({ x: -1.2, y: 0 })).toBe(false);
    r.toggle(player);
    expect(r.inReach(player)).toBe(false);
    session.riding = 'near';
    r.settled();
    expect(r.inReach(player)).toBe(false);
  });
});
