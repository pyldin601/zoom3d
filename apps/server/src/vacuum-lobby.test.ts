import { type JoinMessage, LEVEL1, parseMap, type ServerMessage } from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { Lobby, type LobbySnapshot, type Outbox } from './lobby';
import { VACUUM_RADIUS } from './vacuum-nav';

// Robot vacuum spec §3.1, §3.6, §4: one robot per room, driven by the lobby, saved with the room.
const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB';
const GRACE_MS = 30_000;

let sent: { conn: string; msg: ServerMessage }[];
let time: number;

function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function makeLobby(opts: { vacuum?: boolean } = { vacuum: true }) {
  sent = [];
  time = 0;
  let n = 0;
  const out: Outbox = {
    send: (conn, msg) => sent.push({ conn, msg }),
    broadcast: (conns, msg) => {
      for (const conn of conns) {
        sent.push({ conn, msg });
      }
    },
    close: () => {},
  };
  return new Lobby({
    map: parseMap(LEVEL1),
    out,
    now: () => time,
    rng: seeded(),
    newToken: () => `t${++n}`,
    graceMs: GRACE_MS,
    liveKitFor: () => ({ url: 'ws://lk', token: 'tok' }),
    ...opts,
  });
}

let lobby: Lobby;
beforeEach(() => {
  lobby = makeLobby();
});

const join = (conn: string, extra: Partial<JoinMessage> = {}, roomId = ROOM) =>
  lobby.join(conn, { type: 'join', roomId, name: conn, ...extra });
const welcome = (conn: string) => {
  const w = sent.filter((s) => s.conn === conn && s.msg.type === 'welcome').at(-1)?.msg;
  if (w?.type !== 'welcome') {
    throw new Error(`no welcome for ${conn}`);
  }
  return w;
};
const objectStates = (conn: string) =>
  sent
    .filter((s) => s.conn === conn && s.msg.type === 'object_state')
    .map((s) => s.msg as Extract<ServerMessage, { type: 'object_state' }>);
const step = (times = 1) => {
  for (let i = 0; i < times; i++) {
    lobby.stepWorld(100);
  }
};

describe('one robot vacuum per room', () => {
  test('the first join creates one vacuum, listed in every welcome and never as a peer', () => {
    join('A');
    join('B');
    const [a] = welcome('A').objects;
    expect(a?.kind).toBe('vacuum');
    expect(welcome('B').objects).toEqual([a]);
    expect(welcome('B').peers.map((p) => p.id)).not.toContain(a?.id);
  });

  test('off by default, so a lobby without the option has no objects', () => {
    lobby = makeLobby({});
    join('A');
    step(5);
    expect(welcome('A').objects).toEqual([]);
    expect(objectStates('A')).toEqual([]);
  });

  test('stepWorld broadcasts object_state with rising seq to connected people only', () => {
    join('A');
    join('B');
    lobby.disconnect('B');
    step(20);
    const states = objectStates('A');
    expect(states).toHaveLength(20);
    expect(states.map((s) => s.seq)).toEqual(states.map((_, i) => i + 1));
    expect(states.every((s) => s.id === welcome('A').objects[0]?.id)).toBe(true);
    expect(objectStates('B')).toEqual([]);
  });

  test('a room with nobody connected freezes its vacuum', () => {
    join('A');
    step(50);
    lobby.disconnect('A');
    const before = lobby.snapshot().rooms[0]?.vacuum;
    const count = sent.length;
    step(50);
    expect(sent.length).toBe(count);
    expect(lobby.snapshot().rooms[0]?.vacuum).toEqual(before);
  });

  test('the vacuum never keeps a room open and goes with it', () => {
    join('A');
    const first = welcome('A').objects[0]?.id;
    lobby.disconnect('A');
    time += GRACE_MS;
    lobby.tick();
    expect(lobby.roomCount()).toBe(0);
    join('B');
    expect(welcome('B').objects[0]?.id).not.toBe(first);
  });

  test('each room has its own vacuum', () => {
    join('A');
    join('B', {}, OTHER);
    expect(welcome('A').objects[0]?.id).not.toBe(welcome('B').objects[0]?.id);
  });
});

describe('who it bumps', () => {
  test('bots never count: no bump far from the only person, among 100 bots', () => {
    join('A', { bots: 100 });
    const me = welcome('A').spawn;
    let far = 0;
    for (let i = 0; i < 3 * 60 * 10; i++) {
      step();
      const s = objectStates('A').at(-1);
      if (s && Math.hypot(s.x - me.x, s.y - me.y) > 2) {
        far++;
        expect(s.event).not.toBe('bump');
      }
    }
    expect(far).toBeGreaterThan(1000);
  });

  test('connected people do: four people round the robot get bumped once it drives', () => {
    join('A');
    const snap = lobby.snapshot();
    const room = snap.rooms[0] as LobbySnapshot['rooms'][number];
    const vacuum = room.vacuum as NonNullable<typeof room.vacuum>;
    const peer = room.peers[0] as LobbySnapshot['rooms'][number]['peers'][number];
    const d = VACUUM_RADIUS + 0.1;
    room.peers = [
      [d, 0],
      [-d, 0],
      [0, d],
      [0, -d],
    ].map(([dx, dy], i) => ({
      ...peer,
      id: `p${i}`,
      resumeToken: `r${i}`,
      x: vacuum.x + (dx as number),
      y: vacuum.y + (dy as number),
    }));
    lobby = makeLobby();
    lobby.restore(snap);
    for (let i = 0; i < 4; i++) {
      join(`C${i}`, { resumeToken: `r${i}` });
    }
    step(100);
    expect(objectStates('C0').some((s) => s.event === 'bump')).toBe(true);
  });
});

describe('restart survival', () => {
  test('snapshot carries the vacuum and restore brings it back', () => {
    join('A');
    step(300);
    const last = objectStates('A').at(-1);
    const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
    expect(snap.rooms[0]?.vacuum?.id).toBe(last?.id);
    const token = welcome('A').resumeToken;
    lobby = makeLobby();
    lobby.restore(snap);
    join('A2', { resumeToken: token });
    const [v] = welcome('A2').objects;
    expect(v).toEqual({ id: last?.id, kind: 'vacuum', x: last?.x, y: last?.y, angle: last?.angle });
  });

  test('restore with a missing or mismatched vacuum gives the room a fresh one, people intact', () => {
    join('A');
    const token = welcome('A').resumeToken;
    const snap = lobby.snapshot();
    const old = snap.rooms[0]?.vacuum?.id;
    for (const vacuum of [undefined, { ...snap.rooms[0]?.vacuum, map: 'deadbeef' }]) {
      const room = { ...(snap.rooms[0] as LobbySnapshot['rooms'][number]), vacuum } as LobbySnapshot['rooms'][number];
      lobby = makeLobby();
      lobby.restore({ version: 1, rooms: [room] });
      join('A2', { resumeToken: token });
      const w = welcome('A2');
      expect(w.selfId).toBe(snap.rooms[0]?.peers[0]?.id);
      expect(w.objects).toHaveLength(1);
      expect(w.objects[0]?.id).not.toBe(old);
    }
  });
});
