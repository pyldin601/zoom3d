import {
  BALL_KICK_REACH,
  BALL_RADIUS,
  isWallAt,
  type JoinMessage,
  LEVEL1,
  PROTOCOL_VERSION,
  parseMap,
  type ServerMessage,
  seeded,
  wirePortals,
} from '@zoom3d/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { Lobby, type LobbySnapshot, type Outbox } from '../../lobby';
import { defined } from '../vacuum/test-helpers';

// Ball spec §3.2, §8: one ball per room, stepped by the lobby, kicked and pushed by people, knocked by the vacuum.
const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const TICK_MS = 66;
const map = parseMap(LEVEL1);

let sent: { conn: string; msg: ServerMessage }[];
let time: number;

function makeLobby(opts: { ball?: boolean; vacuum?: boolean } = { ball: true }) {
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
    map,
    out,
    now: () => time,
    rng: seeded(),
    newToken: () => `t${++n}`,
    liveKitFor: () => ({ url: 'ws://lk', token: 'tok' }),
    ...opts,
  });
}

let lobby: Lobby;
beforeEach(() => {
  lobby = makeLobby();
});

const join = (conn: string, extra: Partial<JoinMessage> = {}) =>
  lobby.join(conn, { type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name: conn, ...extra });
const welcome = (conn: string) => {
  const w = sent.filter((s) => s.conn === conn && s.msg.type === 'welcome').at(-1)?.msg;
  if (w?.type !== 'welcome') {
    throw new Error(`no welcome for ${conn}`);
  }
  return w;
};
const ballId = (conn: string) =>
  defined(
    welcome(conn).objects.find((o) => o.kind === 'ball'),
    'ball'
  ).id;
const ballStates = (conn: string) =>
  sent
    .filter((s) => s.conn === conn && s.msg.type === 'object_state' && s.msg.id === ballId(conn))
    .map((s) => s.msg as Extract<ServerMessage, { type: 'object_state' }>);
const step = (times = 1) => {
  for (let i = 0; i < times; i++) {
    time += TICK_MS;
    lobby.stepWorld(TICK_MS);
  }
};

const clearOfWalls = (x: number, y: number) =>
  [-BALL_RADIUS, BALL_RADIUS].every((dx) => [-BALL_RADIUS, BALL_RADIUS].every((dy) => !isWallAt(map, x + dx, y + dy)));

/**
 * Restarts the lobby with the ball `distance` beside the one person (along +x, else −x), and resumes them as `A`.
 * Returns where the person stands and where the ball lies.
 */
function ballBeside(distance: number, opts?: { ball?: boolean; vacuum?: boolean }) {
  lobby = makeLobby(opts);
  join('S');
  const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
  const room = defined(snap.rooms.at(0), 'room');
  const peer = defined(room.peers.at(0), 'peer');
  const side = clearOfWalls(peer.x + distance, peer.y) ? 1 : -1;
  const ball = { x: peer.x + side * distance, y: peer.y };
  expect(clearOfWalls(ball.x, ball.y)).toBe(true);
  room.ball = { ...defined(room.ball, 'saved ball'), ...ball };
  lobby = makeLobby(opts);
  lobby.restore(snap);
  join('A', { resumeToken: peer.resumeToken });
  return { person: { x: peer.x, y: peer.y }, ball, side, id: peer.id };
}

describe('one ball per room', () => {
  test('a new room gets a ball on a floor tile centre, listed in the welcome', () => {
    join('A');
    const ball = defined(
      welcome('A').objects.find((o) => o.kind === 'ball'),
      'ball'
    );
    expect(ball.x % 1).toBe(0.5);
    expect(ball.y % 1).toBe(0.5);
    expect(isWallAt(map, ball.x, ball.y)).toBe(false);
  });

  test('off by default', () => {
    lobby = makeLobby({});
    join('A');
    expect(welcome('A').objects).toEqual([]);
  });

  test('a resting ball sends nothing', () => {
    join('A');
    step(5);
    expect(ballStates('A')).toEqual([]);
  });
});

describe('kicks', () => {
  test('a kick in reach moves it and echoes who kicked and their counter', () => {
    const { person, ball, id } = ballBeside(0.6);
    lobby.kick('A', { type: 'kick', angle: Math.atan2(ball.y - person.y, ball.x - person.x), k: 1 });
    step();
    const state = defined(ballStates('A').at(0), 'state');
    expect(state).toMatchObject({ event: 'kick', by: id, k: 1 });
    expect(Math.hypot(state.vx ?? 0, state.vy ?? 0)).toBeGreaterThan(7);
  });

  test('a kick beyond reach plus slack is dropped', () => {
    ballBeside(BALL_KICK_REACH + 0.6);
    lobby.kick('A', { type: 'kick', angle: 0, k: 1 });
    step();
    expect(ballStates('A')).toEqual([]);
  });

  test('a second kick within 250 ms is dropped', () => {
    const { person, ball } = ballBeside(0.6);
    const angle = Math.atan2(ball.y - person.y, ball.x - person.x);
    lobby.kick('A', { type: 'kick', angle, k: 1 });
    time += 100;
    lobby.kick('A', { type: 'kick', angle: angle + Math.PI, k: 2 });
    step();
    expect(
      ballStates('A')
        .filter((s) => s.event === 'kick')
        .map((s) => s.k)
    ).toEqual([1]);
  });
});

describe('pushes', () => {
  test('a walking person pushes it', () => {
    const { person, side } = ballBeside(0.6);
    lobby.state('A', { type: 'state', x: person.x + side * 0.15, y: person.y, angle: 0, seq: 1 });
    time += TICK_MS;
    lobby.state('A', { type: 'state', x: person.x + side * 0.3, y: person.y, angle: 0, seq: 2 });
    step();
    const state = defined(ballStates('A').at(-1), 'state');
    expect(side * (state.vx ?? 0)).toBeGreaterThan(2);
  });

  test('a pose older than 200 ms counts as standing still', () => {
    const { person, side } = ballBeside(0.6);
    lobby.state('A', { type: 'state', x: person.x + side * 0.15, y: person.y, angle: 0, seq: 1 });
    time += TICK_MS;
    lobby.state('A', { type: 'state', x: person.x + side * 0.3, y: person.y, angle: 0, seq: 2 });
    time += 300;
    step();
    expect(ballStates('A').every((s) => (s.vx ?? 0) === 0 && (s.vy ?? 0) === 0)).toBe(true);
  });

  test('bots never touch it', () => {
    join('A', { bots: 100 });
    const ball = defined(
      welcome('A').objects.find((o) => o.kind === 'ball'),
      'ball'
    );
    const me = welcome('A').spawn;
    expect(Math.hypot(ball.x - me.x, ball.y - me.y)).toBeGreaterThan(1);
    step(300);
    expect(ballStates('A')).toEqual([]);
  });
});

describe('broadcasts', () => {
  test('it stops sending after the tick it stops', () => {
    const { person, ball } = ballBeside(0.6);
    lobby.kick('A', { type: 'kick', angle: Math.atan2(ball.y - person.y, ball.x - person.x), k: 1 });
    step(150);
    const states = ballStates('A');
    const last = defined(states.at(-1), 'last');
    expect(last.vx ?? 0).toBe(0);
    expect(last.vy ?? 0).toBe(0);
    expect(states.filter((s) => (s.vx ?? 0) === 0 && (s.vy ?? 0) === 0)).toHaveLength(1);
    step(10);
    expect(ballStates('A')).toHaveLength(states.length);
  });

  test('a room with nobody connected leaves the ball frozen', () => {
    const { person, ball } = ballBeside(0.6);
    lobby.kick('A', { type: 'kick', angle: Math.atan2(ball.y - person.y, ball.x - person.x), k: 1 });
    lobby.disconnect('A');
    const before = lobby.snapshot().rooms.at(0)?.ball;
    step(10);
    expect(lobby.snapshot().rooms.at(0)?.ball).toEqual(before);
  });
});

describe('the vacuum', () => {
  test('a driving vacuum kicks it, with no kicker in the echo', () => {
    const opts = { ball: true, vacuum: true };
    lobby = makeLobby(opts);
    join('S');
    const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
    const token = defined(snap.rooms.at(0)?.peers.at(0), 'peer').resumeToken;
    /** Restores the same snapshot with the ball moved, so the vacuum does exactly the same thing each time. */
    const replay = (ball: { x: number; y: number } | null) => {
      const copy = JSON.parse(JSON.stringify(snap)) as LobbySnapshot;
      const room = defined(copy.rooms.at(0), 'room');
      if (ball) {
        room.ball = { ...defined(room.ball, 'saved ball'), ...ball };
      }
      lobby = makeLobby(opts);
      lobby.restore(copy);
      join('A', { resumeToken: token });
    };
    replay(null);
    const vacuumId = defined(
      welcome('A').objects.find((o) => o.kind === 'vacuum'),
      'vacuum'
    ).id;
    const path: { x: number; y: number }[] = [];
    for (let i = 0; i < 600; i++) {
      step();
      const v = sent.filter((e) => e.msg.type === 'object_state' && e.msg.id === vacuumId).at(-1)?.msg;
      if (v?.type === 'object_state') {
        path.push({ x: v.x, y: v.y });
      }
    }
    // A stretch where it drives straight for a while; the ball goes where it will be partway along.
    const at = path.findIndex(
      (p, i) =>
        i > 20 && i + 10 < path.length && Math.hypot((path[i + 10]?.x ?? 0) - p.x, (path[i + 10]?.y ?? 0) - p.y) > 0.3
    );
    const target = defined(path.at(at + 8), 'target');
    replay(target);
    step(at + 10);
    expect(ballStates('A').some((s) => s.event === 'kick' && s.by === undefined)).toBe(true);
  });
});

describe('restart survival', () => {
  test('the ball round-trips with the room', () => {
    const { ball } = ballBeside(0.6);
    expect(welcome('A').objects.find((o) => o.kind === 'ball')).toMatchObject({ x: ball.x, y: ball.y });
  });

  test('a snapshot without a ball, or from another map, gives a fresh one', () => {
    join('S');
    const snap = lobby.snapshot();
    const room = defined(snap.rooms.at(0), 'room');
    const token = defined(room.peers.at(0), 'peer').resumeToken;
    for (const ball of [undefined, { ...defined(room.ball, 'ball'), map: 'deadbeef' }]) {
      lobby = makeLobby();
      lobby.restore({ version: 1, rooms: [{ ...room, ball }] });
      join('A', { resumeToken: token });
      expect(welcome('A').objects.filter((o) => o.kind === 'ball')).toHaveLength(1);
    }
  });
});

describe('through portals', () => {
  const portals = wirePortals(map, ROOM);
  const portal = defined(
    portals.list.find((p) => p.toDest.cos !== 1) ?? portals.list.at(0),
    'doorway that turns what goes through it'
  );
  const other = defined(portals.list.at(portal.to), 'destination doorway');
  const alongFront = (p: typeof portal, d: number) => ({ x: p.cx + p.nx * d, y: p.cy + p.ny * d });

  /** A room with portals on (unless `portalsOn` is false), the person at `person` (resumed as A), the ball at `ball`. */
  function setUp(person: { x: number; y: number }, ball: { x: number; y: number }, portalsOn = true) {
    lobby = makeLobby({ ball: true });
    join('S');
    const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
    const room = defined(snap.rooms.at(0), 'room');
    const peer = defined(room.peers.at(0), 'peer');
    Object.assign(peer, person);
    room.ball = { ...defined(room.ball, 'saved ball'), ...ball };
    room.portals = portalsOn;
    lobby = makeLobby({ ball: true });
    lobby.restore(snap);
    join('A', { resumeToken: peer.resumeToken });
    return peer.id;
  }

  test('a person 0.15 tiles past B pushes a ball 0.15 tiles before A, away through the doorway', () => {
    const ball = alongFront(portal, -0.15);
    const standing = alongFront(other, 0.15);
    expect(Math.hypot(standing.x - ball.x, standing.y - ball.y)).toBeGreaterThan(5);
    setUp(standing, ball);
    step();
    const moved = defined(ballStates('A').at(-1), 'ball state');
    const pushedAwayFromDoorway = (moved.x - ball.x) * -portal.nx + (moved.y - ball.y) * -portal.ny;
    expect(pushedAwayFromDoorway).toBeGreaterThan(0.1);
  });

  test('with portals off the same person does not touch the ball', () => {
    const ball = alongFront(portal, -0.15);
    setUp(alongFront(other, 0.15), ball, false);
    step();
    expect(ballStates('A')).toEqual([]);
  });

  test('a kick from past B reaches a ball before A and sends it the way the kicker faces, turned with the portal', () => {
    setUp(alongFront(other, 0.3), alongFront(portal, -1));
    time += 1000;
    lobby.kick('A', { type: 'kick', angle: 0, k: 1 });
    step();
    const kicked = defined(
      ballStates('A').find((s) => s.event === 'kick'),
      'kick state'
    );
    const turn = portal.fromDest;
    expect(Math.cos(Math.atan2(kicked.vy ?? 0, kicked.vx ?? 0) - Math.atan2(turn.sin, turn.cos))).toBeCloseTo(1);
  });

  test('a walker heading for the ball through the doorway pushes it, whichever way the portal turns', () => {
    const standing = (d: number) => alongFront(other, d);
    setUp(standing(0.55), alongFront(portal, -0.1));
    time += 1000;
    lobby.state('A', { type: 'state', ...standing(0.4), angle: 0, seq: 1 });
    time += 50;
    lobby.state('A', { type: 'state', ...standing(0.25), angle: 0, seq: 2 });
    step();
    const pushed = defined(ballStates('A').at(-1), 'ball state');
    expect((pushed.vx ?? 0) * -portal.nx + (pushed.vy ?? 0) * -portal.ny).toBeGreaterThan(2);
  });

  test('stepping through the doorway is a jump, not a speed: it knocks nothing at the exit', () => {
    const start = alongFront(portal, -0.1);
    const arrival = alongFront(other, 0.1);
    setUp(start, alongFront(other, 0.3));
    time += 1000;
    lobby.state('A', { type: 'state', ...start, angle: 0, seq: 1 });
    time += 50;
    lobby.state('A', { type: 'state', ...arrival, angle: 0, seq: 2 });
    step();
    const knocked = ballStates('A').at(-1);
    expect(knocked?.vx ?? 0).toBe(0);
    expect(knocked?.vy ?? 0).toBe(0);
  });
});
