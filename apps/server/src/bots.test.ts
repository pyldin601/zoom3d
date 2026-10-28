import {
  applyAngle,
  FANOUT_TICK_MS,
  isWallAt,
  type JoinMessage,
  LEVEL1,
  MAX_PEERS,
  PEER_COLORS,
  PROTOCOL_VERSION,
  parseMap,
  type ServerMessage,
  wirePortals,
} from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { BOT_COLORS, MAX_BOT_ROOMS, stepBot } from './bots';
import { Lobby, type LobbyEvent, type Outbox } from './lobby';

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
  lobby.join(conn, { type: 'join', v: PROTOCOL_VERSION, roomId, name: conn, ...extra });
const welcome = (conn: string) => {
  const w = sent.find((s) => s.conn === conn && s.msg.type === 'welcome')?.msg;
  if (w?.type !== 'welcome') {
    throw new Error(`no welcome for ${conn}`);
  }
  return w;
};
/** Every pose entry batched to `conn`, in order. */
const posesTo = (conn: string) => sent.flatMap((s) => (s.conn === conn && s.msg.type === 'peers' ? s.msg.s : []));
/** Moves the world one fan-out tick and sends the batches, like the server's timer. */
const tick = (n = 1) => {
  for (let i = 0; i < n; i++) {
    time += FANOUT_TICK_MS;
    lobby.stepWorld(FANOUT_TICK_MS);
    lobby.fanOut();
  }
};

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
  test("stepping moves every bot, never into a wall, and batches their poses like a player's", () => {
    join('A', { bots: 10 });
    const start = new Map(welcome('A').peers.map((b) => [b.slot, b]));
    const map = parseMap(LEVEL1);
    tick(50);
    const poses = posesTo('A');
    for (const [slot, x, y, , age] of poses) {
      expect(start.has(slot)).toBe(true);
      expect(isWallAt(map, x, y)).toBe(false);
      // A bot's pose is stepped in the same tick that sends it.
      expect(age).toBe(0);
    }
    for (const [slot, b] of start) {
      const end = poses.filter((p) => p[0] === slot).at(-1);
      expect(end).toBeDefined();
      expect(Math.hypot((end?.[1] ?? 0) - b.x, (end?.[2] ?? 0) - b.y)).toBeGreaterThan(0.5);
    }
    // One batch per tick at most, never one message per bot.
    expect(sent.filter((s) => s.conn === 'A' && s.msg.type === 'peers').length).toBeLessThanOrEqual(50);
  });

  test('a bot that runs into a wall turns away, like a robot vacuum', () => {
    lobby = makeLobby(parseMap(['1111111', '1S....1', '1111111'].join('\n')));
    join('A', { bots: 1 });
    tick(300);
    const angles = new Set(posesTo('A').map((p) => p[3].toFixed(3)));
    expect(angles.size).toBeGreaterThan(2);
    const xs = posesTo('A').map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(2);
  });

  test('nobody connected: bots rest and nothing is sent', () => {
    join('A', { bots: 5 });
    lobby.disconnect('A');
    sent = [];
    tick();
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

describe('stepBot through portals', () => {
  const level1 = parseMap(LEVEL1);
  const portals = wirePortals(level1, ROOM);
  const portal = portals.list.find((p) => p.door.axis === 'ns') ?? portals.list[0];
  const destination = portals.list.at(portal?.to ?? -1);

  test('a bot walking into a doorway comes out of the destination, turned with it', () => {
    if (!portal || !destination) {
      throw new Error('level1 has no doorway');
    }
    const facing = Math.atan2(portal.ny, portal.nx);
    const bot = { x: portal.cx - portal.nx * 0.05, y: portal.cy - portal.ny * 0.05, angle: facing };
    stepBot(level1, bot, FANOUT_TICK_MS / 1000, () => 0.99, portals);
    expect(Math.hypot(bot.x - destination.cx, bot.y - destination.cy)).toBeLessThan(0.5);
    expect(Math.cos(bot.angle - applyAngle(portal.toDest, facing))).toBeCloseTo(1);
  });

  test('without portals the same step stays on this side', () => {
    if (!portal) {
      throw new Error('level1 has no doorway');
    }
    const bot = {
      x: portal.cx - portal.nx * 0.05,
      y: portal.cy - portal.ny * 0.05,
      angle: Math.atan2(portal.ny, portal.nx),
    };
    stepBot(level1, bot, FANOUT_TICK_MS / 1000, () => 0.99);
    expect(Math.hypot(bot.x - portal.cx, bot.y - portal.cy)).toBeLessThan(0.5);
  });
});
