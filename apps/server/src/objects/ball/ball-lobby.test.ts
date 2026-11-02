import {
  BALL_KICK_REACH,
  BALL_RADIUS,
  BALL_SEES_TILES,
  BALL_STOP_TILES,
  BALL_WAKE_S,
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

interface LobbyTestOptions {
  ball?: boolean;
  vacuum?: boolean;
  ballMind?: boolean;
  graceMs?: number;
}

let sent: { conn: string; msg: ServerMessage }[];
let time: number;

function makeLobby(opts: LobbyTestOptions = { ball: true }) {
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
const refusals = (conn: string) =>
  sent.filter((s) => s.conn === conn && s.msg.type === 'kick_refused').map((s) => s.msg);
const step = (times = 1) => {
  for (let i = 0; i < times; i++) {
    time += TICK_MS;
    lobby.stepWorld(TICK_MS);
  }
};

const WAKE_TICKS = Math.ceil((BALL_WAKE_S * 1000) / TICK_MS) + 1;
const clearOfWalls = (x: number, y: number) =>
  [-BALL_RADIUS, BALL_RADIUS].every((dx) => [-BALL_RADIUS, BALL_RADIUS].every((dy) => !isWallAt(map, x + dx, y + dy)));

/**
 * Restarts the lobby with the ball `distance` beside the one person (along +x, else −x), and resumes them as `A`.
 * Returns where the person stands and where the ball lies.
 */
function ballBeside(distance: number, opts?: LobbyTestOptions) {
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

  test('network jitter between two kicks the client spaced 250 ms apart does not drop the second', () => {
    const { person, ball } = ballBeside(0.6);
    const angle = Math.atan2(ball.y - person.y, ball.x - person.x);
    lobby.kick('A', { type: 'kick', angle, k: 1 });
    time += 220;
    lobby.kick('A', { type: 'kick', angle: angle + Math.PI, k: 2 });
    step();
    expect(ballStates('A').at(-1)).toMatchObject({ event: 'kick', k: 2 });
  });

  test('a kick that arrives just after the ball rolled out of reach still lands', () => {
    const { person, ball } = ballBeside(0.6);
    const angle = Math.atan2(ball.y - person.y, ball.x - person.x);
    lobby.kick('A', { type: 'kick', angle, k: 1 });
    step(4);
    const rolled = defined(ballStates('A').at(-1), 'state');
    expect(Math.hypot(rolled.x - person.x, rolled.y - person.y)).toBeGreaterThan(BALL_KICK_REACH + 0.5);
    lobby.kick('A', { type: 'kick', angle, k: 2 });
    step();
    expect(ballStates('A').at(-1)).toMatchObject({ event: 'kick', k: 2 });
    expect(refusals('A')).toEqual([]);
  });

  test('a kick at a ball long gone is refused, and only the kicker hears', () => {
    const { person, ball } = ballBeside(0.6);
    join('B');
    const angle = Math.atan2(ball.y - person.y, ball.x - person.x);
    lobby.kick('A', { type: 'kick', angle, k: 1 });
    step(10);
    const rolled = defined(ballStates('A').at(-1), 'state');
    expect(Math.hypot(rolled.x - person.x, rolled.y - person.y)).toBeGreaterThan(BALL_KICK_REACH + 2.5);
    lobby.kick('A', { type: 'kick', angle, k: 2 });
    expect(refusals('A')).toEqual([{ type: 'kick_refused', k: 2 }]);
    expect(refusals('B')).toEqual([]);
  });

  test('of two kicks in one tick the later wins, and the earlier kicker hears it did not', () => {
    const { person, ball } = ballBeside(0.6);
    join('B');
    const angle = Math.atan2(ball.y - person.y, ball.x - person.x);
    time += 60_000;
    lobby.state('B', { type: 'state', x: person.x, y: person.y, angle: 0, seq: 1 });
    lobby.kick('A', { type: 'kick', angle, k: 1 });
    lobby.kick('B', { type: 'kick', angle, k: 9 });
    step();
    expect(refusals('B')).toEqual([]);
    expect(ballStates('A').at(-1)).toMatchObject({ event: 'kick', k: 9 });
    expect(refusals('A')).toEqual([{ type: 'kick_refused', k: 1 }]);
  });

  test('a kick beyond reach at a resting ball is refused', () => {
    ballBeside(BALL_KICK_REACH + 0.6);
    lobby.kick('A', { type: 'kick', angle: 0, k: 3 });
    expect(refusals('A')).toEqual([{ type: 'kick_refused', k: 3 }]);
  });

  test('a kick too soon after the last is refused', () => {
    const { person, ball } = ballBeside(0.6);
    const angle = Math.atan2(ball.y - person.y, ball.x - person.x);
    lobby.kick('A', { type: 'kick', angle, k: 1 });
    time += 100;
    lobby.kick('A', { type: 'kick', angle, k: 2 });
    expect(refusals('A')).toEqual([{ type: 'kick_refused', k: 2 }]);
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
  function setUp(
    person: { x: number; y: number },
    ball: { x: number; y: number },
    portalsOn = true,
    opts: LobbyTestOptions = { ball: true }
  ) {
    lobby = makeLobby(opts);
    join('S');
    const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
    const room = defined(snap.rooms.at(0), 'room');
    const peer = defined(room.peers.at(0), 'peer');
    Object.assign(peer, person);
    room.ball = { ...defined(room.ball, 'saved ball'), ...ball };
    room.portals = portalsOn;
    lobby = makeLobby(opts);
    lobby.restore(snap);
    join('A', { resumeToken: peer.resumeToken });
    return peer.id;
  }

  test('a ball kicked through with nobody on the far side wakes up scared', () => {
    const behind = alongFront(portal, -1.5);
    setUp(behind, alongFront(portal, -1), true, { ball: true, ballMind: true });
    time += 1000;
    lobby.kick('A', { type: 'kick', angle: Math.atan2(portal.ny, portal.nx), k: 1 });
    step(WAKE_TICKS);
    const last = defined(ballStates('A').at(-1), 'ball state');
    const fromKicker = Math.hypot(last.x - behind.x, last.y - behind.y);
    expect(fromKicker).toBeGreaterThan(BALL_SEES_TILES);
    expect(last.mood).toBe('scared');
    expect(last.cry).toBe('whimper');
  });

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

describe('its mind (living ball spec §3)', () => {
  const ALIVE = { ball: true, ballMind: true };
  const ballInWelcome = (conn: string) =>
    defined(
      welcome(conn).objects.find((o) => o.kind === 'ball'),
      'ball'
    );

  test('off unless set: no mood, and it rests beside someone for 30 s', () => {
    ballBeside(0.6, { ball: true });
    step(WAKE_TICKS * 3);
    expect(ballStates('A')).toEqual([]);
    expect(ballInWelcome('A').mood).toBeUndefined();
  });

  test('a resting ball says its waking yawn, even though it has not moved', () => {
    ballBeside(0.6, ALIVE);
    step(WAKE_TICKS - 3);
    expect(ballStates('A')).toEqual([]);
    step(3);
    expect(ballStates('A').find((s) => s.cry === 'yawn')?.mood).toBe('wandering');
  });

  test('once awake it heads for someone it can see, and stops at their feet', () => {
    const { person } = ballBeside(2, ALIVE);
    step(WAKE_TICKS + 60);
    const last = defined(ballStates('A').at(-1), 'ball state');
    expect(last.mood).toBe('wiggling');
    expect(Math.hypot(last.x - person.x, last.y - person.y)).toBeLessThanOrEqual(BALL_STOP_TILES + 0.1);
  });

  test('a ball resting in any mood sends nothing further', () => {
    ballBeside(0.6, ALIVE);
    step(WAKE_TICKS + 3);
    const sentSoFar = ballStates('A').length;
    expect(ballStates('A').at(-1)?.mood).toBe('wiggling');
    step(30);
    expect(ballStates('A')).toHaveLength(sentSoFar);
  });

  test('someone joining is told its mood', () => {
    ballBeside(0.6, ALIVE);
    step(WAKE_TICKS + 3);
    join('B');
    expect(ballInWelcome('B').mood).toBe('wiggling');
  });

  /** Everything about the ball's roll after a kick following `ticks` of waiting. */
  const rollAfterKick = (opts: LobbyTestOptions, ticks: number) => {
    const { person, ball } = ballBeside(0.6, opts);
    step(ticks);
    const from = ballStates('A').length;
    lobby.kick('A', { type: 'kick', angle: Math.atan2(ball.y - person.y, ball.x - person.x), k: 1 });
    step(70);
    return ballStates('A').slice(from);
  };

  test('a kick on a wiggling ball moves it exactly as a kick on a ball with no mind', () => {
    const alive = rollAfterKick(ALIVE, WAKE_TICKS + 3);
    const plain = rollAfterKick({ ball: true }, WAKE_TICKS + 3);
    const motion = ({ x, y, vx, vy, angle }: (typeof alive)[number]) => ({ x, y, vx, vy, angle });
    expect(alive.length).toBeGreaterThan(10);
    expect(alive.map(motion)).toEqual(plain.map(motion));
  });

  test('a kick says the yelp and the new mood in the same message as its echo', () => {
    const [first, ...rest] = rollAfterKick(ALIVE, WAKE_TICKS + 3);
    expect(first).toMatchObject({ event: 'kick', mood: 'asleep', cry: 'yelp' });
    expect(rest.every((s) => s.mood === 'asleep' && s.cry === undefined)).toBe(true);
  });

  test('a refused kick says nothing and changes no mood', () => {
    ballBeside(3, ALIVE);
    lobby.kick('A', { type: 'kick', angle: 0, k: 1 });
    step(WAKE_TICKS);
    expect(refusals('A')).toHaveLength(1);
    expect(ballStates('A').some((s) => s.cry === 'yelp')).toBe(false);
    expect(ballStates('A').at(-1)?.mood).not.toBe('asleep');
  });

  test('a kick on a sleeping ball sends no cry', () => {
    const [first] = rollAfterKick(ALIVE, 5);
    expect(first).toMatchObject({ event: 'kick', mood: 'asleep' });
    expect(first?.cry).toBeUndefined();
  });

  test('bots are not seen', () => {
    lobby = makeLobby(ALIVE);
    join('A', { bots: 100 });
    const ball = ballInWelcome('A');
    const spawn = welcome('A').spawn;
    expect(Math.hypot(ball.x - spawn.x, ball.y - spawn.y)).toBeGreaterThan(BALL_SEES_TILES);
    step(WAKE_TICKS + 3);
    expect(ballStates('A').at(-1)?.mood).toBe('wandering');
  });

  test('a restored ball starts asleep, and the snapshot holds no mood', () => {
    ballBeside(0.6, ALIVE);
    step(WAKE_TICKS + 3);
    const snap = lobby.snapshot();
    expect(Object.keys(defined(snap.rooms.at(0)?.ball, 'saved ball')).sort()).toEqual(['map', 'x', 'y']);
    const token = defined(snap.rooms.at(0)?.peers.at(0), 'peer').resumeToken;
    lobby = makeLobby(ALIVE);
    lobby.restore(JSON.parse(JSON.stringify(snap)) as LobbySnapshot);
    join('A', { resumeToken: token });
    expect(ballInWelcome('A').mood).toBe('asleep');
  });

  test('its time does not pass while nobody is connected', () => {
    ballBeside(0.6, ALIVE);
    const token = welcome('A').resumeToken;
    lobby.disconnect('A');
    step(WAKE_TICKS);
    join('A', { resumeToken: token });
    expect(ballInWelcome('A').mood).toBe('asleep');
  });

  test('a room reopened after closing has a new mind, asleep', () => {
    ballBeside(0.6, { ...ALIVE, graceMs: 100 });
    step(WAKE_TICKS + 3);
    lobby.disconnect('A');
    step(5);
    lobby.tick();
    join('B');
    expect(ballInWelcome('B').mood).toBe('asleep');
  });
});
