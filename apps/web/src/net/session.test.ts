import type { PeerInfo, PlayerState } from '@zoom3d/shared';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { asWebSocket, FakeWebSocket } from './fake-websocket';
import { createSession } from './session';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const peer = (id: string, x = 2): PeerInfo => ({ id, name: id, color: '#3cb44b', x, y: 2, angle: 0 });
const welcome = (peers: PeerInfo[] = [], spawn = { x: 5.5, y: 6.5, angle: 1 }) => ({
  type: 'welcome',
  selfId: 'me',
  resumeToken: 'tok',
  color: '#e6194b',
  spawn,
  peers,
});

let player: PlayerState;
beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  player = { x: 0, y: 0, angle: 0 };
});
afterEach(() => vi.useRealTimers());

function joinedSession(peers: PeerInfo[] = []) {
  const session = createSession({
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
  });
  const ws = FakeWebSocket.latest();
  ws.open();
  ws.receive(welcome(peers));
  return { session, ws };
}
const states = (ws: FakeWebSocket) => ws.sent.filter((m) => (m as { type: string }).type === 'state');

test('the first welcome places the player at spawn and records peers', () => {
  const { session } = joinedSession([peer('a')]);
  expect(player).toEqual({ x: 5.5, y: 6.5, angle: 1 });
  expect([...session.peers.keys()]).toEqual(['a']);
  expect(session.selfColor()).toBe('#e6194b');
  expect(session.status()).toBe('open');
});

test('a welcome after reconnect keeps the player but replaces the peer list', () => {
  const { session, ws } = joinedSession([peer('a'), peer('b')]);
  player.x = 9.5;
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  expect(ws2.sent[0]).toMatchObject({ type: 'join', resumeToken: 'tok' });
  ws2.receive(welcome([peer('b')], { x: 1.5, y: 1.5, angle: 0 }));
  expect(player.x).toBe(9.5);
  expect([...session.peers.keys()]).toEqual(['b']);
});

test('peer_state for unknown or departed peers creates no ghosts, and stale seqs are ignored', () => {
  const { session, ws } = joinedSession([peer('a')]);
  ws.receive({ type: 'peer_state', id: 'zz', x: 3, y: 3, angle: 0, seq: 1 });
  expect(session.peers.has('zz')).toBe(false);
  ws.receive({ type: 'peer_state', id: 'a', x: 3, y: 2, angle: 0, seq: 5 });
  vi.advanceTimersByTime(10);
  ws.receive({ type: 'peer_state', id: 'a', x: 9, y: 2, angle: 0, seq: 3 });
  expect(session.peers.get('a')?.buffer.latest()?.x).toBe(3);
  ws.receive({ type: 'peer_left', id: 'a' });
  ws.receive({ type: 'peer_state', id: 'a', x: 4, y: 2, angle: 0, seq: 6 });
  expect(session.peers.size).toBe(0);
});

test('peer_joined adds a peer seeded at its position', () => {
  const { session, ws } = joinedSession();
  ws.receive({ type: 'peer_joined', peer: peer('c', 7) });
  expect(session.peers.get('c')?.buffer.latest()?.x).toBe(7);
});

test('state is sent from a timer when moving and as an idle heartbeat', () => {
  const { ws } = joinedSession();
  player.x += 0.2;
  vi.advanceTimersByTime(66);
  expect(states(ws)).toEqual([{ type: 'state', x: 5.7, y: 6.5, angle: 1, seq: 1 }]);
  vi.advanceTimersByTime(500);
  expect(states(ws)).toHaveLength(1);
  vi.advanceTimersByTime(566);
  expect(states(ws)).toHaveLength(2);
  expect(states(ws)[1]).toMatchObject({ seq: 2 });
});

test('a correction snaps the player', () => {
  const { ws } = joinedSession();
  ws.receive({ type: 'correction', x: 2.5, y: 3.5, angle: 0.5, seq: 1 });
  expect(player).toEqual({ x: 2.5, y: 3.5, angle: 0.5 });
});

test('a fatal error is exposed', () => {
  const session = createSession({
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
  });
  const ws = FakeWebSocket.latest();
  ws.open();
  ws.receive({ type: 'error', code: 'room_full', message: 'full' });
  expect(session.error()).toBe('room_full');
  expect(session.status()).toBe('failed');
});
