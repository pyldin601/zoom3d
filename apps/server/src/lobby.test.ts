import {
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
import { Lobby, type Outbox } from './lobby';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const map = parseMap(LEVEL1);

let sent: { conn: string; msg: ServerMessage }[];
let closed: { conn: string; code: number }[];
let time: number;
let lobby: Lobby;

const outbox: Outbox = {
  send: (conn, msg) => sent.push({ conn, msg }),
  close: (conn, code) => closed.push({ conn, code }),
};

beforeEach(() => {
  sent = [];
  closed = [];
  time = 0;
  let n = 0;
  lobby = new Lobby({ map, out: outbox, now: () => time, rng: () => 0, newToken: () => `t${++n}` });
});

const join = (conn: string, name = conn, extra: Partial<JoinMessage> = {}) =>
  lobby.join(conn, { type: 'join', roomId: ROOM, name, ...extra });
const to = (conn: string) => sent.filter((s) => s.conn === conn).map((s) => s.msg);
const last = (conn: string) => to(conn).at(-1);
function welcome(conn: string) {
  const msg = to(conn).find((m) => m.type === 'welcome');
  if (msg?.type !== 'welcome') throw new Error(`no welcome for ${conn}`);
  return msg;
}

describe('join', () => {
  test('first joiner gets a welcome with no peers, the first colour and a floor spawn near S', () => {
    join('A');
    const w = welcome('A');
    expect(w.peers).toEqual([]);
    expect(w.color).toBe(PEER_COLORS[0]);
    expect(isWallAt(map, w.spawn.x, w.spawn.y)).toBe(false);
    expect(Math.hypot(w.spawn.x - (map.spawn.x + 0.5), w.spawn.y - (map.spawn.y + 0.5))).toBeLessThanOrEqual(
      2,
    );
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
    for (let i = 0; i < MAX_PEERS; i++) join(`c${i}`);
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
