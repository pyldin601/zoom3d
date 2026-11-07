import {
  BALL_PUSH_MAX_SPEED,
  type JoinMessage,
  LEVEL1,
  PROTOCOL_VERSION,
  parseMap,
  RESUME_GRACE_MS,
  RIDE_GRACE_MS,
  rackSpots,
  SCOOTER_COUNT,
  type ServerMessage,
  seeded,
  wirePortals,
} from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { Lobby, type LobbyOptions, type LobbySnapshot, type Outbox } from '../../lobby';
import { defined } from '../vacuum/test-helpers';

// Kick scooter spec §4.2: parked scooters are the room's objects; a ridden one is its rider's `riding`.
const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const TICK_MS = 66;
const map = parseMap(LEVEL1);

let sent: { conn: string; msg: ServerMessage }[];
let time: number;
/** Never reset: a lobby restored from another's snapshot must not hand out the ids that one already gave. */
let tokens = 0;

function makeLobby(opts: Partial<LobbyOptions> = {}) {
  sent = [];
  time = 0;
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
    newToken: () => `t${++tokens}`,
    liveKitFor: () => ({ url: 'ws://lk', token: 'tok' }),
    scooters: true,
    ...opts,
  });
}

let lobby: Lobby;
beforeEach(() => {
  lobby = makeLobby();
});

const join = (conn: string, extra: Partial<JoinMessage> = {}) =>
  lobby.join(conn, { type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name: conn, ...extra });
const to = (conn: string) => sent.filter((s) => s.conn === conn).map((s) => s.msg);
const welcome = (conn: string) => {
  const w = to(conn)
    .filter((m) => m.type === 'welcome')
    .at(-1);
  if (w?.type !== 'welcome') {
    throw new Error(`no welcome for ${conn}`);
  }
  return w;
};
const parked = (conn: string) => welcome(conn).objects.filter((o) => o.kind === 'scooter');
const rides = (conn: string) =>
  to(conn).filter((m): m is Extract<ServerMessage, { type: 'peer_ride' }> => m.type === 'peer_ride');
const corrections = (conn: string) => to(conn).filter((m) => m.type === 'correction');

interface Place {
  x: number;
  y: number;
}

/**
 * Puts people (resumed as A, B, …) and the first scooter where a test wants them, by restoring an edited snapshot:
 * moves are speed-checked, so walking there would take many states.
 */
function setUp(people: Place[], scooter: Place, extra: { portals?: boolean; ball?: Place } = {}) {
  lobby = makeLobby(extra.ball ? { ball: true } : {});
  const names = people.map((_, i) => `S${i}`);
  for (const name of names) {
    join(name);
  }
  const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
  const room = defined(snap.rooms.at(0), 'room');
  for (const [i, p] of room.peers.entries()) {
    Object.assign(p, defined(people.at(i), 'place'), { angle: 0 });
  }
  const saved = defined(room.scooters, 'saved scooters');
  Object.assign(defined(saved.scooters.at(0), 'first scooter'), scooter);
  if (extra.ball) {
    room.ball = { ...defined(room.ball, 'saved ball'), ...extra.ball };
  }
  room.portals = extra.portals === true;
  lobby = makeLobby(extra.ball ? { ball: true } : {});
  lobby.restore(snap);
  const conns = people.map((_, i) => String.fromCharCode(65 + i));
  conns.forEach((conn, i) => {
    join(conn, { name: names.at(i), resumeToken: defined(room.peers.at(i), 'peer').resumeToken });
  });
  const id = defined(saved.scooters.at(0), 'first scooter').id;
  const peerIds = room.peers.map((p) => p.id);
  return { id, peerIds, resumeTokens: room.peers.map((p) => p.resumeToken) };
}

const HALL = { x: 33.5, y: 50.5 };
const beside = (d: number) => ({ x: HALL.x + d, y: HALL.y });

describe('the rack', () => {
  test('a new room has every rack scooter parked, and the joiner rides nothing', () => {
    join('A');
    const w = welcome('A');
    expect(w.riding).toBeNull();
    expect(parked('A').map(({ x, y, angle }) => ({ x, y, angle }))).toEqual(rackSpots(map));
    expect(parked('A')).toHaveLength(SCOOTER_COUNT);
  });

  test('rooms get no scooters unless the lobby is set up with them', () => {
    lobby = makeLobby({ scooters: false });
    join('A');
    expect(parked('A')).toEqual([]);
  });
});

describe('stepping on', () => {
  test('within reach (plus the server lag slack) it rides, and everyone hears', () => {
    const { id, peerIds } = setUp([HALL, beside(-3)], beside(1.3));
    lobby.ride('A', { type: 'ride', id });
    const ride = { type: 'peer_ride', id: peerIds.at(0), scooter: id };
    expect(rides('A')).toEqual([ride]);
    expect(rides('B')).toEqual([ride]);
    join('C');
    expect(parked('C').map((o) => o.id)).not.toContain(id);
    expect(parked('C')).toHaveLength(SCOOTER_COUNT - 1);
    expect(welcome('C').peers.find((p) => p.id === peerIds.at(0))?.riding).toBe(id);
  });

  test('out of reach nothing happens', () => {
    const { id } = setUp([HALL], beside(2));
    lobby.ride('A', { type: 'ride', id });
    expect(rides('A')).toEqual([]);
    join('C');
    expect(parked('C').map((o) => o.id)).toContain(id);
  });

  test('two people racing for one scooter: the first gets it, the second stays on foot', () => {
    const { id, peerIds } = setUp([HALL, beside(1)], beside(0.5));
    lobby.ride('A', { type: 'ride', id });
    lobby.ride('B', { type: 'ride', id });
    expect(rides('A')).toEqual([{ type: 'peer_ride', id: peerIds.at(0), scooter: id }]);
    join('C');
    expect(welcome('C').peers.find((p) => p.id === peerIds.at(1))?.riding).toBeNull();
  });

  test('a rider asking for another scooter is ignored', () => {
    const { id } = setUp([HALL], beside(0.5));
    lobby.ride('A', { type: 'ride', id });
    const other = defined(parked('A').at(0), 'another scooter').id;
    lobby.ride('A', { type: 'ride', id: other });
    expect(rides('A')).toHaveLength(1);
  });

  test('an unknown scooter id is ignored', () => {
    setUp([HALL], beside(0.5));
    lobby.ride('A', { type: 'ride', id: 'nope' });
    expect(rides('A')).toEqual([]);
  });

  test('bots ride nothing', () => {
    join('A', { bots: 5 });
    expect(welcome('A').peers.every((p) => p.riding === null)).toBe(true);
  });
});

describe('speed', () => {
  const ahead = (d: number, seq: number) => ({ type: 'state' as const, x: HALL.x + d, y: HALL.y, angle: 0, seq });

  test('a rider covering 1.2 tiles in 100 ms is let through; on foot the same move is corrected', () => {
    const { id } = setUp([HALL, { x: HALL.x, y: HALL.y + 1 }], beside(0.5));
    lobby.ride('A', { type: 'ride', id });
    time += 100;
    lobby.state('A', ahead(1.2, 1));
    expect(corrections('A')).toEqual([]);
    lobby.state('B', { type: 'state', x: HALL.x + 1.2, y: HALL.y + 1, angle: 0, seq: 1 });
    expect(corrections('B')).toHaveLength(1);
  });

  test('ride-speed poses are let through for a second after stepping off, then corrected', () => {
    const { id } = setUp([HALL], beside(0.5));
    lobby.ride('A', { type: 'ride', id });
    lobby.dismount('A');
    time += 100;
    lobby.state('A', ahead(1.2, 1));
    expect(corrections('A')).toEqual([]);
    time += RIDE_GRACE_MS;
    lobby.state('A', ahead(1.2, 2));
    time += 100;
    lobby.state('A', ahead(2.4, 3));
    expect(corrections('A')).toHaveLength(1);
  });

  test('a rider pushes the ball no harder than a fast walker', () => {
    const { id } = setUp([HALL], beside(0.3), { ball: beside(0.9) });
    lobby.ride('A', { type: 'ride', id });
    for (let i = 1; i <= 3; i++) {
      time += TICK_MS;
      lobby.state('A', ahead(i * 0.4, i));
      lobby.stepWorld(TICK_MS);
    }
    const states = to('A').filter((m) => m.type === 'object_state' && m.vx !== undefined);
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(s.type === 'object_state' && Math.hypot(s.vx ?? 0, s.vy ?? 0)).toBeLessThanOrEqual(
        BALL_PUSH_MAX_SPEED + 1e-9
      );
    }
  });
});

describe('stepping off', () => {
  test('parks the scooter where the server has the rider, facing their way, for everyone', () => {
    const { id, peerIds } = setUp([HALL, beside(-3)], beside(0.5));
    lobby.ride('A', { type: 'ride', id });
    time += 100;
    lobby.state('A', { type: 'state', x: HALL.x + 0.5, y: HALL.y, angle: 1, seq: 1 });
    lobby.dismount('A');
    const off = {
      type: 'peer_ride',
      id: peerIds.at(0),
      scooter: null,
      parked: { id, kind: 'scooter', x: HALL.x + 0.5, y: HALL.y, angle: 1 },
    };
    expect(rides('A').at(-1)).toEqual(off);
    expect(rides('B').at(-1)).toEqual(off);
  });

  test('stepping off on foot does nothing', () => {
    setUp([HALL], beside(0.5));
    lobby.dismount('A');
    expect(rides('A')).toEqual([]);
  });

  test('after crossing a portal the scooter parks at the rider’s real place', () => {
    const portals = wirePortals(map, ROOM);
    const portal = defined(portals.list.at(0), 'doorway');
    const other = defined(portals.list.at(portal.to), 'destination doorway');
    const alongFront = (p: typeof portal, d: number) => ({ x: p.cx + p.nx * d, y: p.cy + p.ny * d });
    const { id } = setUp([alongFront(portal, -0.6)], alongFront(portal, -0.8), { portals: true });
    lobby.ride('A', { type: 'ride', id });
    time += 100;
    lobby.state('A', { type: 'state', ...alongFront(portal, -0.1), angle: 0, seq: 1 });
    const arrival = alongFront(other, 0.3);
    time += 100;
    lobby.state('A', { type: 'state', ...arrival, angle: 0, seq: 2 });
    expect(corrections('A')).toEqual([]);
    lobby.dismount('A');
    const off = defined(rides('A').at(-1), 'dismount');
    expect(off.scooter === null && { x: off.parked.x, y: off.parked.y }).toEqual(arrival);
  });
});

describe('leaving and coming back', () => {
  test('a rider whose grace runs out leaves the scooter parked where they were, before they leave', () => {
    const { id, peerIds } = setUp([HALL, beside(-3)], beside(0.5));
    lobby.ride('A', { type: 'ride', id });
    lobby.disconnect('A');
    time += RESUME_GRACE_MS + 1;
    lobby.tick();
    const after = to('B').slice(to('B').findIndex((m) => m.type === 'peer_ride') + 1);
    const off = after.findIndex((m) => m.type === 'peer_ride');
    const left = after.findIndex((m) => m.type === 'peer_left');
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeLessThan(left);
    expect(after.at(off)).toEqual({
      type: 'peer_ride',
      id: peerIds.at(0),
      scooter: null,
      parked: { id, kind: 'scooter', x: HALL.x, y: HALL.y, angle: 0 },
    });
  });

  test('a rider who reloads within grace comes back riding', () => {
    const { id, resumeTokens } = setUp([HALL], beside(0.5));
    lobby.ride('A', { type: 'ride', id });
    lobby.disconnect('A');
    join('A2', { name: 'S0', resumeToken: resumeTokens.at(0) });
    expect(welcome('A2').riding).toBe(id);
    expect(parked('A2').map((o) => o.id)).not.toContain(id);
  });

  test('a restart parks every scooter: the rider comes back on foot with theirs where they were', () => {
    const { id } = setUp([HALL], beside(0.5));
    lobby.ride('A', { type: 'ride', id });
    const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
    const token = defined(snap.rooms.at(0)?.peers.at(0), 'saved peer').resumeToken;
    lobby = makeLobby();
    lobby.restore(snap);
    join('A', { name: 'S0', resumeToken: token });
    expect(welcome('A').riding).toBeNull();
    expect(parked('A')).toHaveLength(SCOOTER_COUNT);
    expect(parked('A').find((o) => o.id === id)).toMatchObject({ x: HALL.x, y: HALL.y });
  });

  test('a snapshot without scooters restores a fresh rack', () => {
    join('A');
    const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
    const token = defined(snap.rooms.at(0)?.peers.at(0), 'saved peer').resumeToken;
    delete defined(snap.rooms.at(0), 'room').scooters;
    lobby = makeLobby();
    lobby.restore(snap);
    join('A', { name: 'A', resumeToken: token });
    expect(parked('A')).toHaveLength(SCOOTER_COUNT);
  });
});
