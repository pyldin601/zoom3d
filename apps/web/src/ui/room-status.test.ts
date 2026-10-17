// @vitest-environment happy-dom
import { MAX_PEERS } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { createStatusLine, statusText } from './room-status';

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

test('the status line writes only what changed', () => {
  const ui = document.createElement('div');
  const line = createStatusLine(ui);
  line.show('Connecting…', null);
  const status = ui.querySelector('.status');
  expect(status?.textContent).toBe('Connecting…');
  if (status) {
    status.textContent = 'left alone';
  }
  line.show('Connecting…', 3);
  expect(ui.querySelector('.status')?.textContent).toBe('left alone');
  expect(ui.querySelector('.people')).not.toBeNull();
  line.show(null, null);
  expect(ui.querySelector('.status')).toBeNull();
  expect(ui.querySelector('.people')).toBeNull();
});
