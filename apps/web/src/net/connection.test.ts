import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ConnStatus } from './connection';
import { connect } from './connection';
import { asWebSocket, FakeWebSocket } from './fake-websocket';

const join = { type: 'join', roomId: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'Ada' } as const;
const welcome = {
  type: 'welcome',
  selfId: 'p1',
  resumeToken: 't',
  color: '#e6194b',
  spawn: { x: 1, y: 1, angle: 0 },
  peers: [],
  iceServers: [],
};
let statuses: ConnStatus[];

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  statuses = [];
});
afterEach(() => vi.useRealTimers());

const start = () =>
  connect({
    url: 'ws://test/ws',
    makeJoin: () => join,
    onMessage: () => {},
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: asWebSocket,
  });

test('sends the join on open and reports open after the welcome', () => {
  start();
  FakeWebSocket.latest().open();
  expect(FakeWebSocket.latest().sent).toEqual([join]);
  FakeWebSocket.latest().receive(welcome);
  expect(statuses.at(-1)).toBe('open');
});

test('reconnects with exponential backoff', () => {
  start();
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().serverClose(1006);
  expect(statuses.at(-1)).toBe('reconnecting');
  vi.advanceTimersByTime(499);
  expect(FakeWebSocket.instances).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(FakeWebSocket.instances).toHaveLength(2);
  FakeWebSocket.latest().serverClose(1006);
  vi.advanceTimersByTime(999);
  expect(FakeWebSocket.instances).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(FakeWebSocket.instances).toHaveLength(3);
});

test('a welcome resets the backoff', () => {
  start();
  FakeWebSocket.latest().serverClose(1006);
  vi.advanceTimersByTime(500);
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().receive(welcome);
  FakeWebSocket.latest().serverClose(1006);
  vi.advanceTimersByTime(500);
  expect(FakeWebSocket.instances).toHaveLength(3);
});

test('a handshake that never completes is abandoned after 10 s and retried', () => {
  start();
  vi.advanceTimersByTime(9_999);
  expect(FakeWebSocket.latest().readyState).toBe(0);
  vi.advanceTimersByTime(1);
  expect(FakeWebSocket.instances[0]?.readyState).toBe(3);
  expect(statuses.at(-1)).toBe('reconnecting');
  vi.advanceTimersByTime(500);
  expect(FakeWebSocket.instances).toHaveLength(2);
});

test('an open socket that never gets a welcome is abandoned too', () => {
  start();
  FakeWebSocket.latest().open();
  vi.advanceTimersByTime(10_000);
  expect(FakeWebSocket.latest().readyState).toBe(3);
});

test('a welcome cancels the deadline', () => {
  start();
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().receive(welcome);
  vi.advanceTimersByTime(60_000);
  expect(FakeWebSocket.latest().readyState).toBe(1);
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test('a fatal error stops reconnecting', () => {
  start();
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().receive({ type: 'error', code: 'room_full', message: 'full' });
  FakeWebSocket.latest().serverClose(4001);
  vi.advanceTimersByTime(10_000);
  expect(statuses.at(-1)).toBe('failed');
  expect(FakeWebSocket.instances).toHaveLength(1);
});

test('close() stops for good and sends are dropped while not open', () => {
  const conn = start();
  conn.send({ type: 'state', x: 1, y: 1, angle: 0, seq: 1 });
  expect(FakeWebSocket.latest().sent).toEqual([]);
  conn.close();
  vi.advanceTimersByTime(10_000);
  expect(FakeWebSocket.instances).toHaveLength(1);
});
