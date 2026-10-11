import {
  isWallAt,
  type JoinMessage,
  LEVEL1,
  MAX_PEERS,
  PEER_COLORS,
  parseMap,
  type ServerMessage,
} from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { BOT_COLORS, Lobby, type LobbyEvent, MAX_BOT_ROOMS, type Outbox } from './lobby';

// Wandering bots for testing large rooms (opt-in with the room link's ?bots=N).
const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const GRACE_MS = 30_000;

let sent: { conn: string; msg: ServerMessage }[];
let events: LobbyEvent[];
let time: number;

/** Deterministic but varied randomness: bots must not all spawn on one tile or share one heading. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function makeLobby(map = parseMap(LEVEL1)) {
  sent = [];
  events = [];
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
    map,
    out,
    now: () => time,
    rng: seeded(),
    newToken: () => `t${++n}`,
    graceMs: GRACE_MS,
    liveKitFor: () => ({ url: 'ws://lk', token: 'tok' }),
    onEvent: (e) => events.push(e),
  });
}

let lobby: Lobby;
beforeEach(() => {
  lobby = makeLobby();
});

const join = (conn: string, extra: Partial<JoinMessage> = {}, roomId = ROOM) =>
  lobby.join(conn, { type: 'join', roomId, name: conn, ...extra });
const welcome = (conn: string) => {
  const w = sent.find((s) => s.conn === conn && s.msg.type === 'welcome')?.msg;
  if (w?.type !== 'welcome') {
    throw new Error(`no welcome for ${conn}`);
  }
  return w;
};
const statesTo = (conn: string) =>
  sent
    .filter((s) => s.conn === conn && s.msg.type === 'peer_state')
    .map((s) => s.msg as Extract<ServerMessage, { type: 'peer_state' }>);

describe('spawning', () => {
  test('the join that creates a room spawns its bots on floor tiles, spread out, with generic names', () => {
    join('A', { bots: 20 });
    const bots = welcome('A').peers;
    expect(bots).toHaveLength(20);
    const map = parseMap(LEVEL1);
    for (const [i, b] of bots.entries()) {
      expect(b.name).toBe(`Bot ${String(i + 1).padStart(3, '0')}`);
      expect(BOT_COLORS).toContain(b.color);
      expect(PEER_COLORS).not.toContain(b.color);
      expect(isWallAt(map, b.x, b.y)).toBe(false);
      expect(b).toMatchObject({ cam: false, mic: false, avatar: null, held: null, boombox: false });
    }
    expect(new Set(bots.map((b) => `${Math.floor(b.x)},${Math.floor(b.y)}`)).size).toBeGreaterThan(15);
    expect(events).toContainEqual({ type: 'bots_spawned', roomId: ROOM, count: 20 });
  });

  test('bots are outside the people cap, and people still get the player colours', () => {
    join('A', { bots: 30 });
    for (let i = 1; i < MAX_PEERS; i++) {
      join(`P${i}`);
    }
    expect(welcome(`P${MAX_PEERS - 1}`).peers).toHaveLength(30 + MAX_PEERS - 1);
    expect(welcome('A').color).toBe(PEER_COLORS[0]);
    join('late');
    expect(sent.find((s) => s.conn === 'late')?.msg).toMatchObject({ type: 'error', code: 'room_full' });
  });

  test('asking for bots in a room that already exists does nothing', () => {
    join('A');
    join('B', { bots: 10 });
    expect(welcome('B').peers.map((p) => p.name)).toEqual(['A']);
  });

  test(`at most MAX_BOT_ROOMS (${3}) rooms have bots at once`, () => {
    expect(MAX_BOT_ROOMS).toBe(3);
    const rooms = [
      'BBBBBBBBBBBBBBBBBBBBBB',
      'CCCCCCCCCCCCCCCCCCCCCC',
      'DDDDDDDDDDDDDDDDDDDDDD',
      'EEEEEEEEEEEEEEEEEEEEEE',
    ];
    for (const [i, room] of rooms.entries()) {
      join(`p${i}`, { bots: 5 }, room);
    }
    expect(rooms.map((_, i) => welcome(`p${i}`).peers.length)).toEqual([5, 5, 5, 0]);
  });

  test('a bot can never be resumed into, even with a guessed token', () => {
    join('A', { bots: 1 });
    const bot = welcome('A').peers[0];
    for (const resumeToken of ['', 't2', 't3']) {
      join(`X${resumeToken}`, { resumeToken });
      expect(welcome(`X${resumeToken}`).selfId).not.toBe(bot?.id);
    }
  });
});

describe('moving', () => {
  test('stepping moves every bot, never into a wall, and relays each pose with a growing seq', () => {
    join('A', { bots: 10 });
    const start = new Map(welcome('A').peers.map((b) => [b.id, b]));
    const map = parseMap(LEVEL1);
    for (let i = 0; i < 50; i++) {
      lobby.stepWorld(100);
    }
    const states = statesTo('A');
    expect(states).toHaveLength(10 * 50);
    for (const s of states) {
      expect(start.has(s.id)).toBe(true);
      expect(isWallAt(map, s.x, s.y)).toBe(false);
    }
    for (const [id, b] of start) {
      const mine = states.filter((s) => s.id === id);
      expect(mine.map((s) => s.seq)).toEqual(Array.from({ length: 50 }, (_, k) => k + 1));
      const end = mine.at(-1);
      expect(Math.hypot((end?.x ?? 0) - b.x, (end?.y ?? 0) - b.y)).toBeGreaterThan(0.5);
    }
  });

  test('a bot that runs into a wall turns away, like a robot vacuum', () => {
    lobby = makeLobby(parseMap(['1111111', '1S....1', '1111111'].join('\n')));
    join('A', { bots: 1 });
    for (let i = 0; i < 200; i++) {
      lobby.stepWorld(100);
    }
    const angles = new Set(statesTo('A').map((s) => s.angle.toFixed(3)));
    expect(angles.size).toBeGreaterThan(2);
    const xs = statesTo('A').map((s) => s.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(2);
  });

  test('nobody connected: bots rest and nothing is sent', () => {
    join('A', { bots: 5 });
    lobby.disconnect('A');
    sent = [];
    lobby.stepWorld(100);
    expect(sent).toEqual([]);
  });
});

describe('room lifecycle', () => {
  test('bots are counted apart from people', () => {
    join('A', { bots: 12 });
    expect(lobby.stats()).toEqual({ rooms: 1, connected: 1, waiting: 0, bots: 12 });
  });

  test('a person in their resume grace keeps the room; the last person leaving closes it, bots and all', () => {
    join('A', { bots: 5 });
    lobby.disconnect('A');
    time = GRACE_MS - 1;
    lobby.tick();
    expect(lobby.roomCount()).toBe(1);
    time = GRACE_MS;
    lobby.tick();
    expect(lobby.roomCount()).toBe(0);
    expect(events).toContainEqual({ type: 'room_closed', roomId: ROOM });
    expect(lobby.stats()).toEqual({ rooms: 0, connected: 0, waiting: 0, bots: 0 });
  });

  test('bots are not written to the restart snapshot', () => {
    join('A', { bots: 5 });
    const snap = lobby.snapshot();
    expect(snap.rooms[0]?.peers.map((p) => p.name)).toEqual(['A']);
  });
});
