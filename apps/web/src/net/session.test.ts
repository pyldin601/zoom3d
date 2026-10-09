import type { PeerInfo, PlayerState } from '@zoom3d/shared';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { asWebSocket, FakeWebSocket } from './fake-websocket';
import { createSession, type Session, type SessionListener } from './session';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const peer = (id: string, x = 2): PeerInfo => ({
  id,
  name: id,
  color: '#3cb44b',
  x,
  y: 2,
  angle: 0,
  cam: true,
  mic: true,
  avatar: null,
  held: null,
  boombox: false,
});
const welcome = (peers: PeerInfo[] = [], spawn = { x: 5.5, y: 6.5, angle: 1 }) => ({
  type: 'welcome',
  selfId: 'me',
  resumeToken: 'tok',
  color: '#e6194b',
  spawn,
  peers,
  iceServers: [{ urls: ['stun:test'] }],
});

let player: PlayerState;
beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  player = { x: 0, y: 0, angle: 0 };
});
afterEach(() => vi.useRealTimers());

function joinedSession(peers: PeerInfo[] = [], listener: SessionListener = {}, avatar: string | null = null) {
  const session: Session = createSession({
    avatar,
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
    listener,
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

test('a welcome with a new identity (slot expired or server restarted) applies the new spawn', () => {
  const { ws } = joinedSession();
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  ws2.receive({ ...welcome([], { x: 2.5, y: 3.5, angle: 0 }), selfId: 'someone-new' });
  expect(player).toEqual({ x: 2.5, y: 3.5, angle: 0 });
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

test('join carries the avatar picture, also when resuming', () => {
  const pic = 'data:image/jpeg;base64,/9j/';
  const { ws } = joinedSession([], {}, pic);
  expect(ws.sent[0]).toEqual({ type: 'join', roomId: ROOM, name: 'Ada', avatar: pic });
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  expect(ws2.sent[0]).toMatchObject({ type: 'join', resumeToken: 'tok', avatar: pic });
});

test('join without a picture has no avatar field', () => {
  const { ws } = joinedSession();
  expect(ws.sent[0]).not.toHaveProperty('avatar');
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

test('the listener hears welcomes with identity changes, after the session updated itself', () => {
  const calls: unknown[][] = [];
  let session: Session | null = null;
  const result = joinedSession([peer('a')], {
    welcome: (id, ice, changed) => calls.push([id, ice, changed, session?.peers.size ?? 'unset']),
  });
  session = result.session;
  expect(calls).toEqual([['me', [{ urls: ['stun:test'] }], true, 'unset']]);
  expect(session.iceServers()).toEqual([{ urls: ['stun:test'] }]);
  result.ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().receive(welcome([peer('a')]));
  expect(calls[1]).toEqual(['me', [{ urls: ['stun:test'] }], false, 1]);
  FakeWebSocket.latest().serverClose(1006);
  vi.advanceTimersByTime(500);
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().receive({ ...welcome([]), selfId: 'me2' });
  expect(calls[2]?.[2]).toBe(true);
});

test('peer media and signals reach the listener', () => {
  const media: unknown[] = [];
  const signals: unknown[] = [];
  const { session, ws } = joinedSession([peer('a')], {
    peerMedia: (...args) => media.push(args),
    signal: (...args) => signals.push(args),
  });
  ws.receive({ type: 'peer_media', id: 'a', cam: false, mic: true });
  expect(session.peers.get('a')?.info.cam).toBe(false);
  expect(media).toEqual([['a', false, true]]);
  const payload = { kind: 'candidate', candidate: null };
  ws.receive({ type: 'signal', from: 'a', payload });
  expect(signals).toEqual([['a', payload]]);
});

test('peer joins and leaves reach the listener', () => {
  const events: string[] = [];
  const { ws } = joinedSession([], {
    peerJoined: (p) => events.push(`+${p.id}`),
    peerLeft: (id) => events.push(`-${id}`),
  });
  ws.receive({ type: 'peer_joined', peer: peer('c') });
  ws.receive({ type: 'peer_left', id: 'c' });
  expect(events).toEqual(['+c', '-c']);
});

test('sendSignal sends to the server', () => {
  const { session, ws } = joinedSession();
  const payload = { kind: 'candidate', candidate: null } as const;
  session.sendSignal('a', payload);
  expect(ws.sent.at(-1)).toEqual({ type: 'signal', to: 'a', payload });
});

test('media state is sent once open and re-sent after every welcome', () => {
  const session = createSession({
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
  });
  const ws = FakeWebSocket.latest();
  const media = (sock: FakeWebSocket) => sock.sent.filter((m) => (m as { type: string }).type === 'media');
  ws.open();
  session.setMedia(true, false);
  expect(media(ws)).toEqual([]);
  ws.receive(welcome());
  expect(media(ws)).toEqual([{ type: 'media', cam: true, mic: false }]);
  session.setMedia(false, false);
  expect(media(ws).at(-1)).toEqual({ type: 'media', cam: false, mic: false });
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  ws2.receive(welcome());
  expect(media(ws2)).toEqual([{ type: 'media', cam: false, mic: false }]);
});

test('held is sent once open and re-sent after every welcome, including null', () => {
  const session = createSession({
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
  });
  const ws = FakeWebSocket.latest();
  const held = (sock: FakeWebSocket) => sock.sent.filter((m) => (m as { type: string }).type === 'held');
  ws.open();
  session.setHeld('beer');
  expect(held(ws)).toEqual([]);
  ws.receive(welcome());
  expect(held(ws)).toEqual([{ type: 'held', item: 'beer' }]);
  session.setHeld(null);
  expect(held(ws).at(-1)).toEqual({ type: 'held', item: null });
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  ws2.receive(welcome());
  expect(held(ws2)).toEqual([{ type: 'held', item: null }]);
});

test('nothing held is sent if setHeld was never called', () => {
  const { ws } = joinedSession();
  expect(ws.sent.filter((m) => (m as { type: string }).type === 'held')).toEqual([]);
});

test('peer_held updates the peer and ignores unknown ids', () => {
  const { session, ws } = joinedSession([peer('a')]);
  ws.receive({ type: 'peer_held', id: 'a', item: 'coffee' });
  expect(session.peers.get('a')?.info.held).toBe('coffee');
  expect(() => ws.receive({ type: 'peer_held', id: 'zzz', item: 'beer' })).not.toThrow();
});

test('sendDrink sends only while open', () => {
  const session = createSession({
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
  });
  const ws = FakeWebSocket.latest();
  const drinks = () => ws.sent.filter((m) => (m as { type: string }).type === 'drink');
  ws.open();
  session.sendDrink();
  expect(drinks()).toEqual([]);
  ws.receive(welcome());
  session.sendDrink();
  expect(ws.sent.at(-1)).toEqual({ type: 'drink' });
});

test('peer_drink stamps the peer and ignores unknown ids', () => {
  const { session, ws } = joinedSession([peer('a')]);
  expect(session.peers.get('a')?.drinkAt).toBe(Number.NEGATIVE_INFINITY);
  vi.advanceTimersByTime(1234);
  ws.receive({ type: 'peer_drink', id: 'a' });
  expect(session.peers.get('a')?.drinkAt).toBe(Date.now());
  expect(() => ws.receive({ type: 'peer_drink', id: 'zzz' })).not.toThrow();
});

test('a peer_drink during a playing sip is ignored, the next one after it is not', () => {
  const { session, ws } = joinedSession([peer('a')]);
  ws.receive({ type: 'peer_drink', id: 'a' });
  const first = Date.now();
  vi.advanceTimersByTime(1000);
  ws.receive({ type: 'peer_drink', id: 'a' });
  expect(session.peers.get('a')?.drinkAt).toBe(first);
  vi.advanceTimersByTime(400);
  ws.receive({ type: 'peer_drink', id: 'a' });
  expect(session.peers.get('a')?.drinkAt).toBe(Date.now());
});

test('putting the drink down cancels a playing sip', () => {
  const { session, ws } = joinedSession([{ ...peer('a'), held: 'beer' }]);
  ws.receive({ type: 'peer_drink', id: 'a' });
  ws.receive({ type: 'peer_held', id: 'a', item: null });
  expect(session.peers.get('a')?.drinkAt).toBe(Number.NEGATIVE_INFINITY);
});

test('a late joiner sees a drink already in hand', () => {
  const { session } = joinedSession([{ ...peer('a'), held: 'beer' }]);
  expect(session.peers.get('a')?.info.held).toBe('beer');
});
