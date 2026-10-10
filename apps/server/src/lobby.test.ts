import {
  DRINK_GAP_MS,
  isWallAt,
  type JoinMessage,
  LEVEL1,
  MAX_PEERS,
  PEER_COLORS,
  parseMap,
  RESUME_GRACE_MS,
  type ServerMessage,
} from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { Lobby, type LobbyEvent, type Outbox } from './lobby';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const map = parseMap(LEVEL1);

let sent: { conn: string; msg: ServerMessage }[];
let closed: { conn: string; code: number }[];
let events: LobbyEvent[];
let time: number;
let lobby: Lobby;

const outbox: Outbox = {
  send: (conn, msg) => sent.push({ conn, msg }),
  close: (conn, code) => closed.push({ conn, code }),
};

beforeEach(() => {
  sent = [];
  closed = [];
  events = [];
  time = 0;
  let n = 0;
  lobby = new Lobby({
    map,
    out: outbox,
    now: () => time,
    rng: () => 0,
    newToken: () => `t${++n}`,
    iceServersFor: (id) => [{ urls: [`stun:${id}`] }],
    onEvent: (e) => events.push(e),
  });
});

const join = (conn: string, name = conn, extra: Partial<JoinMessage> = {}) =>
  lobby.join(conn, { type: 'join', roomId: ROOM, name, ...extra });
const to = (conn: string) => sent.filter((s) => s.conn === conn).map((s) => s.msg);
const last = (conn: string) => to(conn).at(-1);
function welcome(conn: string) {
  const msg = to(conn).find((m) => m.type === 'welcome');
  if (msg?.type !== 'welcome') {
    throw new Error(`no welcome for ${conn}`);
  }
  return msg;
}

describe('join', () => {
  test('first joiner gets a welcome with no peers, the first colour and a floor spawn near S', () => {
    join('A');
    const w = welcome('A');
    expect(w.peers).toEqual([]);
    expect(w.color).toBe(PEER_COLORS[0]);
    expect(isWallAt(map, w.spawn.x, w.spawn.y)).toBe(false);
    expect(Math.hypot(w.spawn.x - (map.spawn.x + 0.5), w.spawn.y - (map.spawn.y + 0.5))).toBeLessThanOrEqual(2);
  });

  test('second joiner is announced to the first and sees the first in its welcome', () => {
    join('A');
    join('B');
    const announced = last('A');
    expect(announced?.type === 'peer_joined' && announced.peer).toMatchObject({
      name: 'B',
      color: PEER_COLORS[1],
    });
    expect(welcome('B').peers.map((p) => p.name)).toEqual(['A']);
  });

  test('a second join on the same connection is ignored', () => {
    join('A');
    join('A');
    expect(to('A').filter((m) => m.type === 'welcome')).toHaveLength(1);
    expect(lobby.peerCount(ROOM)).toBe(1);
  });

  test('invalid name is rejected with an error and close 4002', () => {
    join('A', '   ');
    expect(last('A')).toMatchObject({ type: 'error', code: 'invalid_name' });
    expect(closed).toEqual([{ conn: 'A', code: 4002 }]);
    expect(lobby.roomCount()).toBe(0);
  });

  test('the ninth joiner gets room_full and close 4001, also while a slot is in grace', () => {
    for (let i = 0; i < MAX_PEERS; i++) {
      join(`c${i}`);
    }
    join('late');
    expect(last('late')).toMatchObject({ type: 'error', code: 'room_full' });
    expect(closed).toContainEqual({ conn: 'late', code: 4001 });

    lobby.disconnect('c0');
    time += RESUME_GRACE_MS - 1;
    lobby.tick();
    join('later');
    expect(last('later')).toMatchObject({ type: 'error', code: 'room_full' });
  });
});

describe('avatars', () => {
  const PIC = 'data:image/jpeg;base64,/9j/4AAQ';

  test('an avatar is relayed to others and to later joiners', () => {
    join('A', 'A', { avatar: PIC });
    join('B');
    const announced = to('A').find((m) => m.type === 'peer_joined');
    expect(announced?.type === 'peer_joined' && announced.peer.avatar).toBeNull();
    expect(welcome('B').peers[0]?.avatar).toBe(PIC);
    join('C', 'C', { avatar: PIC });
    const toB = last('B');
    expect(toB?.type === 'peer_joined' && toB.peer.avatar).toBe(PIC);
  });

  test('an invalid avatar is dropped, not rejected', () => {
    join('A', 'A', { avatar: 'javascript:alert(1)' });
    join('B');
    expect(welcome('B').peers[0]?.avatar).toBeNull();
    expect(closed).toEqual([]);
  });

  test('resume keeps the original avatar', () => {
    join('A', 'A', { avatar: PIC });
    const token = welcome('A').resumeToken;
    lobby.disconnect('A');
    lobby.join('A2', { type: 'join', roomId: ROOM, name: 'A', resumeToken: token });
    join('B');
    expect(welcome('B').peers[0]?.avatar).toBe(PIC);
  });
});

describe('state', () => {
  test('a plausible state is relayed to others with the same seq', () => {
    join('A');
    join('B');
    const { spawn } = welcome('A');
    const before = to('A').length;
    time += 100;
    lobby.state('A', { type: 'state', x: spawn.x, y: spawn.y, angle: 1, seq: 7 });
    expect(last('B')).toEqual({
      type: 'peer_state',
      id: welcome('A').selfId,
      x: spawn.x,
      y: spawn.y,
      angle: 1,
      seq: 7,
    });
    expect(to('A')).toHaveLength(before);
  });

  test('an implausible state is corrected for the sender only', () => {
    join('A');
    join('B');
    const { spawn } = welcome('A');
    const bBefore = to('B').length;
    time += 100;
    lobby.state('A', { type: 'state', x: spawn.x + 10, y: spawn.y, angle: 0, seq: 1 });
    expect(last('A')).toEqual({ type: 'correction', x: spawn.x, y: spawn.y, angle: spawn.angle, seq: 1 });
    expect(to('B')).toHaveLength(bBefore);
  });

  test('state from an unjoined connection is ignored', () => {
    lobby.state('ghost', { type: 'state', x: 1, y: 1, angle: 0, seq: 0 });
    expect(sent).toEqual([]);
  });
});

describe('disconnect and resume', () => {
  test('peer_left is sent only after the grace period', () => {
    join('A');
    join('B');
    lobby.disconnect('B');
    time += RESUME_GRACE_MS - 1;
    lobby.tick();
    expect(to('A').some((m) => m.type === 'peer_left')).toBe(false);
    time += 2;
    lobby.tick();
    expect(last('A')).toEqual({ type: 'peer_left', id: welcome('B').selfId });
    expect(lobby.peerCount(ROOM)).toBe(1);
  });

  test('resuming within grace keeps id and colour and is silent to others', () => {
    join('A');
    join('B');
    const first = welcome('B');
    const aBefore = to('A').length;
    lobby.disconnect('B');
    time += 1000;
    join('B2', 'B', { resumeToken: first.resumeToken });
    const resumed = welcome('B2');
    expect(resumed.selfId).toBe(first.selfId);
    expect(resumed.color).toBe(first.color);
    expect(resumed.peers.map((p) => p.name)).toEqual(['A']);
    expect(to('A')).toHaveLength(aBefore);
  });

  test('resuming while the old connection is still bound replaces it', () => {
    join('A');
    join('B');
    const first = welcome('B');
    const aBefore = to('A').length;
    join('B2', 'B', { resumeToken: first.resumeToken });
    expect(welcome('B2').selfId).toBe(first.selfId);
    expect(closed).toContainEqual({ conn: 'B', code: 4003 });
    expect(to('A')).toHaveLength(aBefore);
    expect(lobby.peerCount(ROOM)).toBe(2);
    lobby.disconnect('B');
    time += RESUME_GRACE_MS + 1;
    lobby.tick();
    expect(lobby.peerCount(ROOM)).toBe(2);
  });

  test('a resumed peer keeps relaying state through its new connection', () => {
    join('A');
    join('B');
    const first = welcome('B');
    lobby.disconnect('B');
    join('B2', 'B', { resumeToken: first.resumeToken });
    time += 100;
    lobby.state('B2', { type: 'state', x: first.spawn.x, y: first.spawn.y, angle: 2, seq: 3 });
    expect(last('A')).toMatchObject({ type: 'peer_state', id: first.selfId, angle: 2 });
  });

  test('resuming after grace is a fresh join', () => {
    join('A');
    join('B');
    const first = welcome('B');
    lobby.disconnect('B');
    time += RESUME_GRACE_MS + 1;
    lobby.tick();
    join('B2', 'B', { resumeToken: first.resumeToken });
    expect(welcome('B2').selfId).not.toBe(first.selfId);
    expect(last('A')).toMatchObject({ type: 'peer_joined' });
  });

  test('a freed colour is reused and an empty room is deleted', () => {
    join('A');
    join('B');
    lobby.disconnect('A');
    time += RESUME_GRACE_MS + 1;
    lobby.tick();
    join('C');
    expect(welcome('C').color).toBe(PEER_COLORS[0]);
    lobby.disconnect('B');
    lobby.disconnect('C');
    time += RESUME_GRACE_MS + 1;
    lobby.tick();
    expect(lobby.roomCount()).toBe(0);
  });

  test('disconnect of an unknown connection is harmless', () => {
    expect(() => lobby.disconnect('nobody')).not.toThrow();
  });
});

describe('media and signalling', () => {
  const payload = { kind: 'candidate', candidate: null } as const;
  const deliveredTo = (conn: string) => to(conn).filter((m) => m.type === 'signal');

  test('the welcome carries ICE servers for the joiner', () => {
    join('A');
    expect(welcome('A').iceServers).toEqual([{ urls: [`stun:${welcome('A').selfId}`] }]);
  });

  test('a signal is delivered to its target in the same room', () => {
    join('A');
    join('B');
    lobby.signal('A', { type: 'signal', to: welcome('B').selfId, payload });
    expect(deliveredTo('B')).toEqual([{ type: 'signal', from: welcome('A').selfId, payload }]);
  });

  test('signals to self, unknown ids, other rooms or disconnected peers are dropped', () => {
    join('A');
    join('B');
    lobby.join('X', { type: 'join', roomId: 'BBBBBBBBBBBBBBBBBBBBBB', name: 'X' });
    const xId = welcome('X').selfId;
    lobby.signal('A', { type: 'signal', to: welcome('A').selfId, payload });
    lobby.signal('A', { type: 'signal', to: 'nobody', payload });
    lobby.signal('A', { type: 'signal', to: xId, payload });
    lobby.disconnect('B');
    lobby.signal('A', { type: 'signal', to: welcome('B').selfId, payload });
    lobby.signal('ghost', { type: 'signal', to: welcome('A').selfId, payload });
    expect(sent.filter((s) => s.msg.type === 'signal')).toEqual([]);
  });

  test('media state is broadcast and shown to later joiners', () => {
    join('A');
    join('B');
    lobby.media('A', { type: 'media', cam: true, mic: false });
    expect(last('B')).toEqual({ type: 'peer_media', id: welcome('A').selfId, cam: true, mic: false });
    join('C');
    expect(welcome('C').peers.find((p) => p.name === 'A')).toMatchObject({ cam: true, mic: false });
    expect(welcome('C').peers.find((p) => p.name === 'B')).toMatchObject({ cam: false, mic: false });
  });
});

describe('held items', () => {
  test('a new peer holds nothing', () => {
    join('A');
    join('B');
    expect(welcome('B').peers[0]?.held).toBeNull();
  });

  test('held is broadcast to the others, not the sender, and shown to later joiners', () => {
    join('A');
    join('B');
    const aSent = to('A').length;
    lobby.held('A', { type: 'held', item: 'beer' });
    expect(last('B')).toEqual({ type: 'peer_held', id: welcome('A').selfId, item: 'beer' });
    expect(to('A')).toHaveLength(aSent);
    join('C');
    expect(welcome('C').peers.find((p) => p.name === 'A')?.held).toBe('beer');
    expect(to('A').at(-1)).toMatchObject({ type: 'peer_joined', peer: { held: null } });
  });

  test('resume keeps held', () => {
    join('A');
    join('B');
    lobby.held('B', { type: 'held', item: 'wine' });
    lobby.disconnect('B');
    join('B2', 'B', { resumeToken: welcome('B').resumeToken });
    join('C');
    expect(welcome('C').peers.find((p) => p.name === 'B')?.held).toBe('wine');
  });

  test('held before join is ignored', () => {
    lobby.held('ghost', { type: 'held', item: 'beer' });
    expect(sent).toEqual([]);
  });
});

describe('cheers', () => {
  const cheers = (conn: string) => to(conn).filter((m) => m.type === 'peer_cheers');
  beforeEach(() => {
    join('A');
    join('B');
    lobby.held('A', { type: 'held', item: 'beer' });
  });

  test('a cheers is relayed to the others, not the sender', () => {
    const aSent = to('A').length;
    lobby.cheers('A');
    expect(last('B')).toEqual({ type: 'peer_cheers', id: welcome('A').selfId });
    expect(to('A')).toHaveLength(aSent);
  });

  test('nothing in hand, no cheers', () => {
    lobby.held('A', { type: 'held', item: null });
    lobby.cheers('A');
    expect(cheers('B')).toEqual([]);
  });

  test('a sip and a cheers share one gap', () => {
    lobby.drink('A');
    time = DRINK_GAP_MS - 1;
    lobby.cheers('A');
    expect(cheers('B')).toEqual([]);
    time = DRINK_GAP_MS;
    lobby.cheers('A');
    expect(cheers('B')).toHaveLength(1);
  });

  test('cheers are not stored: a later joiner gets no peer_cheers', () => {
    lobby.cheers('A');
    join('C');
    expect(cheers('C')).toEqual([]);
  });
});

describe('sips', () => {
  const drinks = (conn: string) => to(conn).filter((m) => m.type === 'peer_drink');
  beforeEach(() => {
    join('A');
    join('B');
    lobby.held('A', { type: 'held', item: 'beer' });
  });

  test('a sip is relayed to the others, not the sender', () => {
    const aSent = to('A').length;
    lobby.drink('A');
    expect(last('B')).toEqual({ type: 'peer_drink', id: welcome('A').selfId });
    expect(to('A')).toHaveLength(aSent);
  });

  test('nothing in hand, no sip', () => {
    lobby.held('A', { type: 'held', item: null });
    lobby.drink('A');
    expect(drinks('B')).toEqual([]);
  });

  test('a second sip within DRINK_GAP_MS is dropped, a later one is relayed', () => {
    lobby.drink('A');
    time = DRINK_GAP_MS - 1;
    lobby.drink('A');
    expect(drinks('B')).toHaveLength(1);
    time = 1200;
    lobby.drink('A');
    expect(drinks('B')).toHaveLength(2);
  });

  test('sips are not stored: a later joiner gets no peer_drink', () => {
    lobby.drink('A');
    join('C');
    expect(drinks('C')).toEqual([]);
  });

  test('a sip before join is ignored', () => {
    const before = sent.length;
    lobby.drink('ghost');
    expect(sent).toHaveLength(before);
  });
});

describe('boombox', () => {
  test('a new peer has no boombox', () => {
    join('A');
    join('B');
    expect(welcome('B').peers[0]?.boombox).toBe(false);
  });

  test('boombox is broadcast to the others, not the sender, and shown to later joiners', () => {
    join('A');
    join('B');
    const aSent = to('A').length;
    lobby.boombox('A', { type: 'boombox', on: true });
    expect(last('B')).toEqual({ type: 'peer_boombox', id: welcome('A').selfId, on: true });
    expect(to('A')).toHaveLength(aSent);
    join('C');
    expect(welcome('C').peers.find((p) => p.name === 'A')?.boombox).toBe(true);
  });

  test('resume keeps the boombox', () => {
    join('A');
    join('B');
    lobby.boombox('B', { type: 'boombox', on: true });
    lobby.disconnect('B');
    join('B2', 'B', { resumeToken: welcome('B').resumeToken });
    join('C');
    expect(welcome('C').peers.find((p) => p.name === 'B')?.boombox).toBe(true);
  });

  test('boombox before join is ignored', () => {
    lobby.boombox('ghost', { type: 'boombox', on: true });
    expect(sent).toEqual([]);
  });
});

describe('snapshot and restore', () => {
  let m = 0;
  /** Replaces the lobby with a new one restored from its JSON snapshot, as a restarted server would. */
  const restart = () => {
    const next = new Lobby({
      map,
      out: outbox,
      now: () => time,
      rng: () => 0,
      newToken: () => `r${++m}`,
      onEvent: (e) => events.push(e),
    });
    next.restore(JSON.parse(JSON.stringify(lobby.snapshot())));
    lobby = next;
  };

  test('a restored slot resumes with its id, colour, pose and flags, and sees the others', () => {
    join('A');
    join('B');
    const a = welcome('A');
    lobby.media('A', { type: 'media', cam: true, mic: true });
    lobby.held('A', { type: 'held', item: 'beer' });
    lobby.boombox('A', { type: 'boombox', on: true });
    time = 5000;
    restart();
    expect(lobby.peerCount(ROOM)).toBe(2);

    join('A2', 'A', { resumeToken: a.resumeToken });
    const resumed = welcome('A2');
    expect(resumed.selfId).toBe(a.selfId);
    expect(resumed.color).toBe(a.color);
    expect(resumed.spawn).toEqual(a.spawn);
    expect(resumed.peers.map((p) => p.name)).toEqual(['B']);
    join('C');
    expect(welcome('C').peers.find((p) => p.name === 'A')).toMatchObject({
      cam: true,
      mic: true,
      held: 'beer',
      boombox: true,
    });
  });

  test('each restored room is reported opened, so its later close has a match', () => {
    join('A');
    events = [];
    restart();
    expect(events).toEqual([{ type: 'room_opened', roomId: ROOM }]);
  });

  test('a fresh join after restore gets a colour nobody holds', () => {
    join('A');
    join('B');
    restart();
    join('C');
    expect(welcome('C').color).toBe(PEER_COLORS[2]);
  });

  test('the snapshot holds no connection or sip state', () => {
    join('A');
    expect(Object.keys(lobby.snapshot().rooms[0]?.peers[0] ?? {}).sort()).toEqual(
      [
        'angle',
        'avatar',
        'boombox',
        'cam',
        'color',
        'held',
        'id',
        'lastAcceptedAt',
        'mic',
        'name',
        'resumeToken',
        'x',
        'y',
      ].sort()
    );
  });

  test('restored slots get a full grace period from the restore, then expire', () => {
    join('A');
    join('B');
    const a = welcome('A');
    time = 100_000;
    restart();
    join('A2', 'A', { resumeToken: a.resumeToken });
    time += RESUME_GRACE_MS - 1;
    lobby.tick();
    expect(lobby.peerCount(ROOM)).toBe(2);
    time += 1;
    lobby.tick();
    expect(lobby.peerCount(ROOM)).toBe(1);
    expect(last('A2')).toEqual({ type: 'peer_left', id: welcome('B').selfId });
    lobby.disconnect('A2');
    time += RESUME_GRACE_MS;
    lobby.tick();
    expect(lobby.roomCount()).toBe(0);
  });
});

describe('events and stats', () => {
  test('a first join opens the room; joins report the room size', () => {
    join('A');
    join('B');
    expect(events).toEqual([
      { type: 'room_opened', roomId: ROOM },
      { type: 'joined', roomId: ROOM, peerId: 't1', resumed: false, replaced: false, peers: 1 },
      { type: 'joined', roomId: ROOM, peerId: 't3', resumed: false, replaced: false, peers: 2 },
    ]);
  });

  test('rejections carry the reason', () => {
    join('A', '');
    lobby.join('B', { type: 'join', roomId: 'bad', name: 'B' });
    for (let i = 0; i < MAX_PEERS + 1; i++) {
      join(`P${i}`);
    }
    expect(events.filter((e) => e.type === 'rejected')).toEqual([
      { type: 'rejected', reason: 'invalid_name' },
      { type: 'rejected', reason: 'invalid_room' },
      { type: 'rejected', reason: 'room_full' },
    ]);
  });

  test('disconnect, resume, replace, expiry and room close are reported', () => {
    join('A');
    const token = welcome('A').resumeToken;
    join('A2', 'A', { resumeToken: token });
    lobby.disconnect('A2');
    join('A3', 'A', { resumeToken: token });
    lobby.disconnect('A3');
    time += RESUME_GRACE_MS;
    lobby.tick();
    expect(events.slice(2)).toEqual([
      { type: 'joined', roomId: ROOM, peerId: 't1', resumed: true, replaced: true, peers: 1 },
      { type: 'disconnected', roomId: ROOM, peerId: 't1' },
      { type: 'joined', roomId: ROOM, peerId: 't1', resumed: true, replaced: false, peers: 1 },
      { type: 'disconnected', roomId: ROOM, peerId: 't1' },
      { type: 'left', roomId: ROOM, peerId: 't1', peers: 0 },
      { type: 'room_closed', roomId: ROOM },
    ]);
  });

  test('an implausible move is reported', () => {
    join('A');
    lobby.state('A', { type: 'state', x: 99, y: 99, angle: 0, seq: 1 });
    expect(events.at(-1)).toEqual({ type: 'move_corrected', roomId: ROOM, peerId: 't1' });
  });

  test('stats count rooms and connected and waiting peers', () => {
    join('A');
    join('B');
    lobby.join('C', { type: 'join', roomId: 'BBBBBBBBBBBBBBBBBBBBBB', name: 'C' });
    lobby.disconnect('B');
    expect(lobby.stats()).toEqual({ rooms: 2, connected: 2, waiting: 1 });
  });
});
