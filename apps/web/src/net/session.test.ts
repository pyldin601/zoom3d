import type { GameMap, PeerInfo, PlayerState, Portals } from '@zoom3d/shared';
import { LEVEL1, PROTOCOL_VERSION, parseMap, wirePortals } from '@zoom3d/shared';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { asWebSocket, FakeWebSocket } from './fake-websocket';
import { tierInterval } from './peer-delay';
import { createSession, type Session, type SessionListener } from './session';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
let slots = 0;
const peer = (id: string, x = 2, slot = slots++): PeerInfo => ({
  id,
  slot,
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
  livekit: { url: 'ws://lk', token: 'tok' },
  portals: false,
});

let player: PlayerState;
beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  player = { x: 0, y: 0, angle: 0 };
});
afterEach(() => vi.useRealTimers());

function joinedSession(
  peers: PeerInfo[] = [],
  listener: SessionListener = {},
  avatar: string | null = null,
  map?: GameMap,
  portals?: () => Portals | null
) {
  const session: Session = createSession({
    avatar,
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    map,
    portals,
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

test('a peers batch moves each listed peer, found by slot', () => {
  const { session, ws } = joinedSession([peer('a', 2, 4), peer('b', 3, 7)]);
  vi.advanceTimersByTime(66);
  ws.receive({ type: 'peers', s: [[7, 3.5, 2, 1, 0]] });
  expect(session.peers.get('b')?.info).toMatchObject({ x: 3.5, y: 2, angle: 1 });
  expect(session.peers.get('b')?.buffer.latest()).toMatchObject({ x: 3.5, y: 2, angle: 1 });
  expect(session.peers.get('a')?.info.x).toBe(2);
  ws.receive({
    type: 'peers',
    s: [
      [4, 2.5, 2, 0, 0],
      [7, 4, 2, 1, 0],
    ],
  });
  expect(session.peers.get('a')?.info.x).toBe(2.5);
  expect(session.peers.get('b')?.info.x).toBe(4);
});

test('entries for unknown or departed slots create no ghosts', () => {
  const { session, ws } = joinedSession([peer('a', 2, 1)]);
  ws.receive({ type: 'peers', s: [[9, 3, 3, 0, 0]] });
  expect([...session.peers.keys()]).toEqual(['a']);
  ws.receive({ type: 'peer_left', id: 'a' });
  ws.receive({ type: 'peers', s: [[1, 4, 2, 0, 0]] });
  expect(session.peers.size).toBe(0);
});

test('a peer joining later is found by its slot', () => {
  const { session, ws } = joinedSession();
  ws.receive({ type: 'peer_joined', peer: peer('c', 7, 12) });
  ws.receive({ type: 'peers', s: [[12, 7.5, 2, 0, 0]] });
  expect(session.peers.get('c')?.info.x).toBe(7.5);
});

test('a welcome after reconnect rebuilds the slots', () => {
  const { session, ws } = joinedSession([peer('a', 2, 1)]);
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  ws2.receive(welcome([peer('b', 3, 2)]));
  ws2.receive({
    type: 'peers',
    s: [
      [1, 9, 9, 0, 0],
      [2, 3.5, 2, 0, 0],
    ],
  });
  expect([...session.peers.keys()]).toEqual(['b']);
  expect(session.peers.get('b')?.info.x).toBe(3.5);
});

test('a far peer moving after standing still starts from where it stood, not mid-way', () => {
  const { session, ws } = joinedSession([peer('far', 40, 3)]);
  vi.advanceTimersByTime(5000);
  const t = Date.now();
  ws.receive({ type: 'peers', s: [[3, 41, 2, 0, 0]] });
  const out = { x: 0, y: 0, angle: 0 };
  session.peers.get('far')?.buffer.sample(t - tierInterval(false), out);
  expect(out.x).toBe(40);
});

test('a peer far on the map but near through a portal is held one tick back, as the server sends it every tick', () => {
  const map = parseMap(LEVEL1);
  const portals = wirePortals(map, ROOM);
  const pair = portals.list
    .map((portal) => ({ portal, other: portals.list.at(portal.to) }))
    .find(({ portal, other }) => other && Math.hypot(portal.cx - other.cx, portal.cy - other.cy) > 20);
  if (!pair?.other) {
    throw new Error('level1 has no pair of doorways far apart');
  }
  const { portal, other } = pair;
  const stood = { x: other.cx + other.nx, y: other.cy + other.ny };
  const { session, ws } = joinedSession([{ ...peer('seen', stood.x, 3), y: stood.y }], {}, null, map, () => portals);
  // The welcome put the player at spawn: in front of the doorway instead.
  player.x = portal.cx - portal.nx;
  player.y = portal.cy - portal.ny;
  vi.advanceTimersByTime(5000);
  const t = Date.now();
  ws.receive({ type: 'peers', s: [[3, stood.x + 0.05, stood.y, 0, 0]] });
  const out = { x: 0, y: 0, angle: 0 };
  session.peers.get('seen')?.buffer.sample(t - tierInterval(true), out);
  expect(out.x).toBe(stood.x);
});

test('an entry is placed when the server accepted it (arrival minus its age), not when the batch came', () => {
  const { session, ws } = joinedSession([peer('a', 2, 4)]);
  vi.advanceTimersByTime(1000);
  const t = Date.now();
  ws.receive({ type: 'peers', s: [[4, 2.5, 4, 0, 50]] });
  expect(session.peers.get('a')?.buffer.latest()).toMatchObject({ t: t - 50, x: 2.5 });
});

test('an entry that would land before the last one (faster network) goes just after it instead', () => {
  const { session, ws } = joinedSession([peer('a', 2, 4)]);
  vi.advanceTimersByTime(1000);
  const t = Date.now();
  ws.receive({ type: 'peers', s: [[4, 2.5, 4, 0, 0]] });
  vi.advanceTimersByTime(10);
  ws.receive({ type: 'peers', s: [[4, 2.6, 4, 0, 30]] });
  expect(session.peers.get('a')?.buffer.latest()).toMatchObject({ t: t + 1, x: 2.6 });
});

test('join carries the protocol version', () => {
  joinedSession();
  expect(FakeWebSocket.latest().sent[0]).toMatchObject({ type: 'join', v: PROTOCOL_VERSION });
});

test('join asks for bots when given (only matters for the join that creates the room)', () => {
  createSession({
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    bots: 100,
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
  });
  const ws = FakeWebSocket.latest();
  ws.open();
  expect(ws.sent[0]).toEqual({ type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name: 'Ada', bots: 100 });
});

test('join carries the avatar picture, also when resuming', () => {
  const pic = 'data:image/jpeg;base64,/9j/';
  const { ws } = joinedSession([], {}, pic);
  expect(ws.sent[0]).toEqual({ type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name: 'Ada', avatar: pic });
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

test('a resume sends the current pose on the next tick: the server has the one from before the outage', () => {
  const { ws } = joinedSession();
  // Moved, but the old socket died before the next tick could send it.
  player.x = 9.5;
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  ws2.receive(welcome());
  vi.advanceTimersByTime(66);
  expect(states(ws2)).toEqual([expect.objectContaining({ x: 9.5 })]);
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

test('the listener hears status changes after the session applied them, also with the tab hidden', () => {
  const calls: unknown[][] = [];
  let session: Session | null = null;
  const listener: SessionListener = {
    status: (s) => calls.push([s, session?.peers.size, session?.error()]),
  };
  const result = joinedSession([peer('a'), peer('b')], listener);
  session = result.session;
  result.ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().receive(welcome([peer('a')]));
  FakeWebSocket.latest().receive({ type: 'error', code: 'room_full', message: 'full' });
  // The first 'open' fires inside createSession's welcome, before `session` is assigned here.
  expect(calls).toEqual([
    ['open', undefined, undefined],
    ['reconnecting', 2, null],
    ['open', 1, null],
    ['failed', 1, 'room_full'],
  ]);
});

test('the listener hears welcomes with identity changes, after the session updated itself', () => {
  const calls: unknown[][] = [];
  let session: Session | null = null;
  const result = joinedSession([peer('a')], {
    welcome: (id, livekit, changed) => calls.push([id, livekit, changed, session?.peers.size ?? 'unset']),
  });
  session = result.session;
  expect(calls).toEqual([['me', { url: 'ws://lk', token: 'tok' }, true, 'unset']]);
  result.ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().receive(welcome([peer('a')]));
  expect(calls[1]).toEqual(['me', { url: 'ws://lk', token: 'tok' }, false, 1]);
  FakeWebSocket.latest().serverClose(1006);
  vi.advanceTimersByTime(500);
  FakeWebSocket.latest().open();
  FakeWebSocket.latest().receive({ ...welcome([]), selfId: 'me2' });
  expect(calls[2]?.[2]).toBe(true);
});

test('peer media reaches the listener', () => {
  const media: unknown[] = [];
  const { session, ws } = joinedSession([peer('a')], {
    peerMedia: (...args) => media.push(args),
  });
  ws.receive({ type: 'peer_media', id: 'a', cam: false, mic: true });
  expect(session.peers.get('a')?.info.cam).toBe(false);
  expect(media).toEqual([['a', false, true]]);
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

test('sendCheers sends only while open', () => {
  const session = createSession({
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
  });
  const ws = FakeWebSocket.latest();
  const cheers = () => ws.sent.filter((m) => (m as { type: string }).type === 'cheers');
  ws.open();
  session.sendCheers();
  expect(cheers()).toEqual([]);
  ws.receive(welcome());
  session.sendCheers();
  expect(ws.sent.at(-1)).toEqual({ type: 'cheers' });
});

test("peer_cheers starts that peer's cheers", () => {
  const { session, ws } = joinedSession([peer('a')]);
  vi.advanceTimersByTime(500);
  ws.receive({ type: 'peer_cheers', id: 'a' });
  expect(session.peers.get('a')?.gesture).toEqual({ kind: 'cheers', at: Date.now() });
});

test('a sip arriving during a playing cheers is ignored, one after it is not', () => {
  const { session, ws } = joinedSession([peer('a')]);
  ws.receive({ type: 'peer_cheers', id: 'a' });
  const first = Date.now();
  vi.advanceTimersByTime(1000);
  ws.receive({ type: 'peer_drink', id: 'a' });
  expect(session.peers.get('a')?.gesture).toEqual({ kind: 'cheers', at: first });
  vi.advanceTimersByTime(600);
  ws.receive({ type: 'peer_drink', id: 'a' });
  expect(session.peers.get('a')?.gesture).toEqual({ kind: 'sip', at: Date.now() });
});

test('peer_drink stamps the peer and ignores unknown ids', () => {
  const { session, ws } = joinedSession([peer('a')]);
  expect(session.peers.get('a')?.gesture).toBeNull();
  vi.advanceTimersByTime(1234);
  ws.receive({ type: 'peer_drink', id: 'a' });
  expect(session.peers.get('a')?.gesture).toEqual({ kind: 'sip', at: Date.now() });
  expect(() => ws.receive({ type: 'peer_drink', id: 'zzz' })).not.toThrow();
});

test('a peer_drink during a playing sip is ignored, the next one after it is not', () => {
  const { session, ws } = joinedSession([peer('a')]);
  ws.receive({ type: 'peer_drink', id: 'a' });
  const first = Date.now();
  vi.advanceTimersByTime(1000);
  ws.receive({ type: 'peer_drink', id: 'a' });
  expect(session.peers.get('a')?.gesture).toEqual({ kind: 'sip', at: first });
  vi.advanceTimersByTime(400);
  ws.receive({ type: 'peer_drink', id: 'a' });
  expect(session.peers.get('a')?.gesture).toEqual({ kind: 'sip', at: Date.now() });
});

test('putting the drink down cancels a playing sip', () => {
  const { session, ws } = joinedSession([{ ...peer('a'), held: 'beer' }]);
  ws.receive({ type: 'peer_drink', id: 'a' });
  ws.receive({ type: 'peer_held', id: 'a', item: null });
  expect(session.peers.get('a')?.gesture).toBeNull();
});

test('a late joiner sees a drink already in hand', () => {
  const { session } = joinedSession([{ ...peer('a'), held: 'beer' }]);
  expect(session.peers.get('a')?.info.held).toBe('beer');
});

test('boombox is sent once open and re-sent after every welcome, including false', () => {
  const session = createSession({
    url: 'ws://t/ws',
    roomId: ROOM,
    name: 'Ada',
    player,
    now: Date.now,
    WebSocketImpl: asWebSocket,
  });
  const ws = FakeWebSocket.latest();
  const boombox = (sock: FakeWebSocket) => sock.sent.filter((m) => (m as { type: string }).type === 'boombox');
  ws.open();
  session.setBoombox(true);
  expect(boombox(ws)).toEqual([]);
  ws.receive(welcome());
  expect(boombox(ws)).toEqual([{ type: 'boombox', on: true }]);
  session.setBoombox(false);
  expect(boombox(ws).at(-1)).toEqual({ type: 'boombox', on: false });
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  ws2.receive(welcome());
  expect(boombox(ws2)).toEqual([{ type: 'boombox', on: false }]);
});

test('nothing boombox is sent if setBoombox was never called', () => {
  const { ws } = joinedSession();
  expect(ws.sent.filter((m) => (m as { type: string }).type === 'boombox')).toEqual([]);
});

test('peer_boombox updates the peer and ignores unknown ids', () => {
  const { session, ws } = joinedSession([peer('a')]);
  ws.receive({ type: 'peer_boombox', id: 'a', on: true });
  expect(session.peers.get('a')?.info.boombox).toBe(true);
  expect(() => ws.receive({ type: 'peer_boombox', id: 'zzz', on: true })).not.toThrow();
});

// World objects (robot vacuum spec §4): kept next to peers, with the same interpolation and stale-seq rules.
const vacuum = { id: 'v', kind: 'vacuum', x: 3.5, y: 4.5, angle: 0 };
const objectState = (seq: number, x = 3.5, event?: string) => ({
  type: 'object_state',
  id: 'v',
  x,
  y: 4.5,
  angle: 0,
  seq,
  ...(event ? { event } : {}),
});

function withVacuum(listener: SessionListener = {}) {
  const session = createSession({
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
  ws.receive({ ...welcome(), objects: [vacuum] });
  return { session, ws };
}

test('welcome fills objects with a buffered pose', () => {
  const { session } = withVacuum();
  const v = session.objects.get('v');
  expect(v?.info).toEqual(vacuum);
  expect(v?.buffer.latest()).toMatchObject({ x: 3.5, y: 4.5, angle: 0 });
  expect(session.peers.size).toBe(0);
});

test('object_state updates the pose and drops stale seq', () => {
  const { session, ws } = withVacuum();
  ws.receive(objectState(5, 4));
  vi.advanceTimersByTime(10);
  ws.receive(objectState(3, 9));
  expect(session.objects.get('v')?.info.x).toBe(4);
  expect(session.objects.get('v')?.buffer.latest()?.x).toBe(4);
});

test('a welcome resets object seq, so a restarted server is followed', () => {
  const { session, ws } = withVacuum();
  ws.receive(objectState(50, 4));
  ws.serverClose(1006);
  vi.advanceTimersByTime(500);
  const ws2 = FakeWebSocket.latest();
  ws2.open();
  ws2.receive({ ...welcome(), objects: [vacuum] });
  ws2.receive(objectState(1, 6));
  expect(session.objects.get('v')?.info.x).toBe(6);
});

test('object_state with an event tells the listener once, after applying the pose', () => {
  const seen: [string, string, number | undefined][] = [];
  const { session, ws } = withVacuum({
    objectEvent: (id, e) => seen.push([id, e, session.objects.get(id)?.info.x]),
  });
  ws.receive(objectState(1, 3.6));
  ws.receive(objectState(2, 3.7, 'bump'));
  expect(seen).toEqual([['v', 'bump', 3.7]]);
});

test('object_state for an unknown object is ignored', () => {
  const { session, ws } = withVacuum();
  ws.receive({ ...objectState(1), id: 'zz' });
  expect([...session.objects.keys()]).toEqual(['v']);
});

// The ball (ball spec §3.3, §4): kicks go out with a counter, and every applied state reaches the prediction.
test('sendKick sends the angle and the kick counter', () => {
  const { session, ws } = withVacuum();
  session.sendKick(1.25, 3);
  expect(ws.sent.at(-1)).toEqual({ type: 'kick', angle: 1.25, k: 3 });
});

test('objectState hears every applied state with its velocity and echo, and never a stale one', () => {
  const heard: unknown[] = [];
  const { ws } = withVacuum({ objectState: (m) => heard.push(m) });
  ws.receive({ ...objectState(2, 4, 'kick'), vx: 1, vy: 2, by: 'me', k: 1 });
  ws.receive(objectState(1, 9));
  expect(heard).toEqual([{ ...objectState(2, 4, 'kick'), vx: 1, vy: 2, by: 'me', k: 1 }]);
});

test("objectEvent carries a kick's kicker", () => {
  const seen: unknown[] = [];
  const { ws } = withVacuum({ objectEvent: (id, e, by) => seen.push([id, e, by]) });
  ws.receive({ ...objectState(1, 4, 'kick'), by: 'p1', k: 2 });
  expect(seen).toEqual([['v', 'kick', 'p1']]);
});

test('objectsReset hears the objects of every welcome', () => {
  const heard: unknown[] = [];
  withVacuum({ objectsReset: (objects) => heard.push(objects) });
  expect(heard).toEqual([[vacuum]]);
});

test('the portals flag comes from the welcome without telling the listener', () => {
  const changes: boolean[] = [];
  const { session, ws } = joinedSession([], { portalsChanged: (on) => changes.push(on) });
  expect(session.portals).toBe(false);
  ws.receive({ ...welcome(), portals: true });
  expect(session.portals).toBe(true);
  expect(changes).toEqual([]);
});

test('a portals message sets the flag and reaches the listener after the session took it', () => {
  const seen: [boolean, boolean][] = [];
  const holder: { session?: Session } = {};
  const { session, ws } = joinedSession([], {
    portalsChanged: (on) => seen.push([on, holder.session?.portals ?? false]),
  });
  holder.session = session;
  ws.receive({ type: 'portals', on: true });
  ws.receive({ type: 'portals', on: false });
  expect(seen).toEqual([
    [true, true],
    [false, false],
  ]);
  expect(session.portals).toBe(false);
});

test('sendPortals asks the server to flip them', () => {
  const { session, ws } = joinedSession();
  session.sendPortals();
  expect(ws.sent.at(-1)).toEqual({ type: 'portals' });
});

// Interpolation never glides across a jump (portal doorways spec §2.4).
const HALL = parseMap(
  [
    '1'.repeat(40),
    `1S${'.'.repeat(37)}1`,
    ...Array.from({ length: 5 }, () => `1${'.'.repeat(38)}1`),
    '1'.repeat(40),
  ].join('\n')
);

test('a peer pose no walk explains is marked a jump; an ordinary step is not', () => {
  const { session, ws } = joinedSession([peer('a', 2, 4)], {}, null, HALL);
  vi.advanceTimersByTime(66);
  ws.receive({ type: 'peers', s: [[4, 2.2, 2, 0, 0]] });
  expect(session.peers.get('a')?.buffer.latest()?.jump).toBeUndefined();
  vi.advanceTimersByTime(66);
  ws.receive({ type: 'peers', s: [[4, 22.2, 2, 0, 0]] });
  expect(session.peers.get('a')?.buffer.latest()?.jump).toBe(true);
});

test('a jump after a pause is not blended into from the held pose', () => {
  const { session, ws } = joinedSession([peer('far', 3, 3)], {}, null, HALL);
  vi.advanceTimersByTime(5000);
  const t = Date.now();
  ws.receive({ type: 'peers', s: [[3, 36, 2, 0, 0]] });
  const out = { x: 0, y: 0, angle: 0 };
  session.peers.get('far')?.buffer.sample(t - 1, out);
  expect(out.x).toBe(3);
});

test('an object that moved more than JUMP_TILES in one state is marked a jump', () => {
  const { session, ws } = joinedSession([], {}, null, HALL);
  ws.receive({ ...welcome(), objects: [vacuum] });
  vi.advanceTimersByTime(66);
  ws.receive(objectState(1, 4.5));
  expect(session.objects.get('v')?.buffer.latest()?.jump).toBeUndefined();
  vi.advanceTimersByTime(66);
  ws.receive(objectState(2, 24.5));
  expect(session.objects.get('v')?.buffer.latest()?.jump).toBe(true);
});
