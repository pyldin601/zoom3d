import { MAX_PEERS } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { statusText } from './room-status';

test('nothing while connected; the connection while it connects', () => {
  expect(statusText('open', null)).toBeNull();
  expect(statusText('connecting', null)).toBe('Connecting…');
  expect(statusText('reconnecting', null)).toBe('Reconnecting…');
});

test('a failure says why when it can', () => {
  expect(statusText('failed', 'room_full')).toBe(`This room is full (${MAX_PEERS} people)`);
  expect(statusText('failed', 'outdated')).toBe('zoom3d was updated: reload the page');
  expect(statusText('failed', 'invalid_room')).toBe("Couldn't join this room");
  expect(statusText('failed', null)).toBe("Couldn't join this room");
});
