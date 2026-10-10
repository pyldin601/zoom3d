import type { PeerInfo } from '@zoom3d/shared';
import { beforeEach, expect, test } from 'vitest';
import type { Session } from '../net/session';
import type { AnalyticsEvent } from './analytics';
import { createRoomTracker, type RoomTracker, withRoomTracker } from './room-tracker';

let events: AnalyticsEvent[];
let time: number;
let tracker: RoomTracker;

beforeEach(() => {
  events = [];
  time = 0;
  tracker = createRoomTracker(
    (e) => events.push(e),
    () => time
  );
});

test('the first open reports a join with the peers already there', () => {
  tracker.update('connecting', 0, null);
  time = 500;
  tracker.update('open', 2, null);
  tracker.update('open', 2, null);
  expect(events).toEqual([
    { name: 'room_joined', peers: 2 },
    { name: 'peer_met', afterS: 0 },
  ]);
});

test('a drop and a recovery after joining are reported with the downtime', () => {
  tracker.update('open', 0, null);
  time = 10_000;
  tracker.update('reconnecting', 0, null);
  time = 13_400;
  tracker.update('open', 1, null);
  expect(events.slice(1)).toEqual([
    { name: 'connection_lost' },
    { name: 'connection_restored', downS: 3 },
    { name: 'peer_met', afterS: 13 },
  ]);
});

test('retries before the first welcome are not drops', () => {
  tracker.update('connecting', 0, null);
  tracker.update('reconnecting', 0, null);
  tracker.update('open', 0, null);
  expect(events).toEqual([{ name: 'room_joined', peers: 0 }]);
});

test('a failure is reported once with its reason and whether the room was ever joined', () => {
  tracker.update('connecting', 0, null);
  tracker.update('failed', 0, 'room_full');
  tracker.update('failed', 0, 'room_full');
  expect(events).toEqual([{ name: 'connection_failed', reason: 'room_full', joined: false }]);
});

test('leaving reports the duration, the largest room seen and the drops, once', () => {
  time = 1000;
  tracker.update('open', 1, null);
  tracker.update('open', 4, null);
  tracker.update('reconnecting', 4, null);
  tracker.update('open', 2, null);
  time = 1000 + 125_600;
  tracker.leave();
  tracker.leave();
  expect(events.at(-1)).toEqual({ name: 'room_left', durationS: 126, peersMax: 4, drops: 1 });
  expect(events.filter((e) => e.name === 'room_left')).toHaveLength(1);
});

test('the largest room counts peers who joined between status changes', () => {
  tracker.update('open', 1, null);
  tracker.peers(2);
  tracker.peers(5);
  tracker.peers(3);
  tracker.leave();
  expect(events.at(-1)).toMatchObject({ name: 'room_left', peersMax: 5 });
});

test('meeting another person is reported once, with the wait since joining', () => {
  time = 1000;
  tracker.update('open', 0, null);
  time = 1000 + 42_400;
  tracker.peers(1);
  tracker.peers(2);
  expect(events.filter((e) => e.name === 'peer_met')).toEqual([{ name: 'peer_met', afterS: 42 }]);
});

test('someone already in the room is met on joining', () => {
  tracker.update('open', 2, null);
  expect(events).toEqual([
    { name: 'room_joined', peers: 2 },
    { name: 'peer_met', afterS: 0 },
  ]);
});

test('peers seen before the first welcome are not a meeting', () => {
  tracker.peers(1);
  expect(events).toEqual([]);
});

test('leaving a room never joined reports nothing', () => {
  tracker.update('connecting', 0, null);
  tracker.leave();
  expect(events).toEqual([]);
});

test('withRoomTracker feeds status and room size from the session, keeping the wrapped callbacks', () => {
  const seen: string[] = [];
  const session = { peers: new Map([['a', {}]]), error: () => null } as unknown as Session;
  const listener = withRoomTracker(
    { status: (s) => seen.push(s), peerJoined: (p) => seen.push(p.id) },
    tracker,
    () => session
  );
  listener.status?.('open');
  session.peers.set('b', {} as never);
  session.peers.set('c', {} as never);
  listener.peerJoined?.({ id: 'c' } as PeerInfo);
  tracker.leave();
  expect(seen).toEqual(['open', 'c']);
  expect(events).toEqual([
    { name: 'room_joined', peers: 1 },
    { name: 'peer_met', afterS: 0 },
    { name: 'room_left', durationS: 0, peersMax: 3, drops: 0 },
  ]);
});
