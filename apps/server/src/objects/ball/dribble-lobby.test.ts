import {
  BALL_KICK_GAP_MS,
  BALL_KICK_REACH,
  BALL_KICK_SPEED,
  BALL_RADIUS,
  carryThroughPortal,
  holdSpot,
  isWallAt,
  type JoinMessage,
  LEVEL1,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  parseMap,
  type ServerMessage,
  seeded,
  wirePortals,
} from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { Lobby, type LobbySnapshot, type Outbox } from '../../lobby';
import { defined } from '../vacuum/test-helpers';

// Ball dribble spec §2, §4.1: the server holds the ball for one dribbler, places it at their hand, and lets go of it
// on E, a throw, a steal, or their leaving.
const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const TICK_MS = 66;
const map = parseMap(LEVEL1);

interface Options {
  ball?: boolean;
  ballMind?: boolean;
  vacuum?: boolean;
  scooters?: boolean;
  graceMs?: number;
}

let sent: { conn: string; msg: ServerMessage }[] = [];
let time = 0;
let lobby: Lobby;

function makeLobby(opts: Options) {
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

const join = (conn: string, extra: Partial<JoinMessage> = {}) =>
  lobby.join(conn, { type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name: conn, ...extra });
const step = (times = 1) => {
  for (let i = 0; i < times; i++) {
    time += TICK_MS;
    lobby.stepWorld(TICK_MS);
  }
};
const ballIdFor = (conn: string) => {
  const w = sent.filter((s) => s.conn === conn && s.msg.type === 'welcome').at(-1)?.msg;
  return w?.type === 'welcome' ? w.objects.find((o) => o.kind === 'ball')?.id : undefined;
};
const ballStates = (conn: string) =>
  sent
    .filter((s) => s.conn === conn && s.msg.type === 'object_state' && s.msg.id === ballIdFor(conn))
    .map((s) => s.msg as Extract<ServerMessage, { type: 'object_state' }>);
const lastBall = (conn: string) => defined(ballStates(conn).at(-1), 'ball state');
const dribbleRefusals = (conn: string) => sent.filter((s) => s.conn === conn && s.msg.type === 'dribble_refused');
const clearOfWalls = (x: number, y: number) =>
  [-BALL_RADIUS, BALL_RADIUS].every((dx) => [-BALL_RADIUS, BALL_RADIUS].every((dy) => !isWallAt(map, x + dx, y + dy)));

interface Person {
  x: number;
  y: number;
  angle?: number;
}

/**
 * Restarts the lobby with the given people (resumed as A, B, …) and the ball at `ball`; portals on if asked.
 * Returns the people's ids.
 */
function setUp(people: Person[], ball: { x: number; y: number }, opts: Options = { ball: true }, portalsOn = false) {
  lobby = makeLobby(opts);
  const conns = people.map((_, i) => String.fromCharCode(65 + i));
  for (const conn of conns) {
    join(`s${conn}`, { name: conn });
  }
  const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
  const room = defined(snap.rooms.at(0), 'room');
  for (const [i, peer] of room.peers.entries()) {
    Object.assign(peer, { angle: 0, ...people.at(i) });
  }
  room.ball = { ...defined(room.ball, 'saved ball'), ...ball };
  room.portals = portalsOn;
  lobby = makeLobby(opts);
  lobby.restore(snap);
  for (const [i, conn] of conns.entries()) {
    const peer = defined(room.peers.at(i), 'peer');
    join(conn, { name: conn, resumeToken: peer.resumeToken });
  }
  return room.peers.map((p) => p.id);
}

/** The spawn room's first person, and a ball 0.6 tiles east or west of them, whichever is open. */
function spawnSpot() {
  lobby = makeLobby({ ball: true });
  join('probe');
  const snap = lobby.snapshot();
  const peer = defined(snap.rooms.at(0)?.peers.at(0), 'peer');
  const side = clearOfWalls(peer.x + 0.6, peer.y) ? 1 : -1;
  return {
    person: { x: peer.x, y: peer.y, angle: side === 1 ? 0 : Math.PI },
    ball: { x: peer.x + side * 0.6, y: peer.y },
  };
}

let seq = 0;
const pose = (conn: string, x: number, y: number, angle: number) => {
  time += TICK_MS;
  lobby.state(conn, { type: 'state', x, y, angle, seq: ++seq });
};

const hand = (p: Person) => holdSpot(map, null, p.x, p.y, p.angle ?? 0, { x: 0, y: 0 });

describe('picking it up', () => {
  test('a dribble in reach holds the ball for the asker, at their hand', () => {
    const { person, ball } = spawnSpot();
    const [id] = setUp([person], ball);
    lobby.dribble('A');
    step();
    const state = lastBall('A');
    expect(state.heldBy).toBe(id);
    expect(state.x).toBeCloseTo(hand(person).x);
    expect(state.y).toBeCloseTo(hand(person).y);
  });

  test('someone joining sees who holds it', () => {
    const { person, ball } = spawnSpot();
    const [id] = setUp([person], ball);
    lobby.dribble('A');
    step();
    join('C');
    const w = defined(sent.filter((s) => s.conn === 'C' && s.msg.type === 'welcome').at(-1)?.msg, 'welcome');
    expect(w.type === 'welcome' && w.objects.find((o) => o.kind === 'ball')?.heldBy).toBe(id);
  });

  test('a dribble out of reach is refused', () => {
    const { person, ball } = spawnSpot();
    const away = Math.sign(ball.x - person.x) * (BALL_KICK_REACH + 0.6);
    setUp([person], { x: person.x + away, y: person.y });
    lobby.dribble('A');
    step();
    expect(dribbleRefusals('A')).toHaveLength(1);
    expect(ballStates('A').every((s) => s.heldBy === undefined)).toBe(true);
  });

  test('the dribbler asking again is no refusal', () => {
    const { person, ball } = spawnSpot();
    const [a] = setUp([person], ball);
    lobby.dribble('A');
    step();
    lobby.dribble('A');
    step();
    expect(dribbleRefusals('A')).toHaveLength(0);
    expect(lastBall('A').heldBy).toBe(a);
  });

  test('a ball someone holds cannot be taken by another dribble', () => {
    const { person, ball } = spawnSpot();
    const [a] = setUp([person, { x: ball.x, y: ball.y + 0.5 }], ball);
    lobby.dribble('A');
    lobby.dribble('B');
    step();
    expect(dribbleRefusals('B')).toHaveLength(1);
    expect(lastBall('B').heldBy).toBe(a);
  });

  test('a rider cannot dribble, and a dribbler cannot ride', () => {
    lobby = makeLobby({ ball: true, scooters: true });
    join('A');
    const w = defined(sent.filter((s) => s.conn === 'A' && s.msg.type === 'welcome').at(-1)?.msg, 'welcome');
    if (w.type !== 'welcome') {
      throw new Error('no welcome');
    }
    const scooter = defined(
      w.objects.find((o) => o.kind === 'scooter'),
      'scooter'
    );
    const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
    const room = defined(snap.rooms.at(0), 'room');
    const peer = defined(room.peers.at(0), 'peer');
    Object.assign(peer, { x: scooter.x - 0.5, y: scooter.y, angle: 0 });
    room.ball = { ...defined(room.ball, 'saved ball'), x: scooter.x - 0.5, y: scooter.y - 0.5 };
    lobby = makeLobby({ ball: true, scooters: true });
    lobby.restore(snap);
    join('A', { resumeToken: peer.resumeToken });

    lobby.dribble('A');
    step();
    lobby.ride('A', { type: 'ride', id: scooter.id });
    expect(sent.some((s) => s.msg.type === 'peer_ride')).toBe(false);

    lobby.release('A');
    step();
    lobby.ride('A', { type: 'ride', id: scooter.id });
    expect(sent.some((s) => s.msg.type === 'peer_ride')).toBe(true);
    lobby.dribble('A');
    expect(dribbleRefusals('A')).toHaveLength(1);
  });
});

describe('while held', () => {
  test('it follows its dribbler walking and turning, moving as they move', () => {
    const { person, ball } = spawnSpot();
    setUp([person], ball);
    lobby.dribble('A');
    step();
    const dir = Math.cos(person.angle);
    pose('A', person.x + dir * 0.1, person.y, person.angle + 0.5);
    step();
    const walked = lastBall('A');
    const there = hand({ x: person.x + dir * 0.1, y: person.y, angle: person.angle + 0.5 });
    expect(walked.x).toBeCloseTo(there.x);
    expect(walked.y).toBeCloseTo(there.y);
    expect(dir * (walked.vx ?? 0)).toBeGreaterThan(0.5);
  });

  test('its mind sleeps: a held ball is asleep, says nothing, and stays at the hand', () => {
    const { person, ball } = spawnSpot();
    setUp([person], ball, { ball: true, ballMind: true });
    step(200);
    lobby.dribble('A');
    step(200);
    const held = ballStates('A').filter((s) => s.heldBy !== undefined);
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((s) => (s.mood ?? 'asleep') === 'asleep' && s.cry === undefined)).toBe(true);
    expect(lastBall('A').x).toBeCloseTo(hand(person).x);
  });

  test('a standing person it touches does not take it', () => {
    const { person, ball } = spawnSpot();
    const there = hand(person);
    const [a] = setUp([person, { x: there.x, y: there.y + PLAYER_RADIUS }], ball);
    lobby.dribble('A');
    step(3);
    expect(lastBall('A').heldBy).toBe(a);
  });

  test('a walking person who touches it knocks it loose', () => {
    const { person, ball } = spawnSpot();
    const there = hand(person);
    setUp([person, { x: there.x, y: there.y + 0.6 }], ball);
    lobby.dribble('A');
    step();
    pose('B', there.x, there.y + 0.45, -Math.PI / 2);
    pose('B', there.x, there.y + 0.3, -Math.PI / 2);
    step();
    expect(lastBall('A').heldBy).toBeUndefined();
  });

  test('the vacuum does not touch it', () => {
    const { person, ball } = spawnSpot();
    const [a] = setUp([person], ball, { ball: true, vacuum: true });
    lobby.dribble('A');
    step(300);
    expect(lastBall('A').heldBy).toBe(a);
  });

  test('it goes through a portal with its dribbler', () => {
    const portals = wirePortals(map, ROOM);
    const portal = defined(portals.list.at(0), 'portal');
    const before = { x: portal.cx - portal.nx * 0.4, y: portal.cy - portal.ny * 0.4 };
    const facing = Math.atan2(portal.ny, portal.nx);
    setUp([{ ...before, angle: facing }], { x: before.x, y: before.y }, { ball: true }, true);
    lobby.dribble('A');
    step();
    const near = lastBall('A');
    expect(Math.hypot(near.x - before.x, near.y - before.y)).toBeLessThan(BALL_KICK_REACH);
    // Walk through at a stroll, carried through the doorway as the client carries itself.
    const walker = { ...before, angle: facing };
    let crossed = false;
    for (let i = 0; i < 6; i++) {
      const from = { x: walker.x, y: walker.y };
      walker.x += Math.cos(walker.angle) * 0.15;
      walker.y += Math.sin(walker.angle) * 0.15;
      crossed = carryThroughPortal(portals, from.x, from.y, walker) || crossed;
      pose('A', walker.x, walker.y, walker.angle);
    }
    expect(crossed).toBe(true);
    step();
    const far = lastBall('A');
    expect(Math.hypot(far.x - walker.x, far.y - walker.y)).toBeLessThan(BALL_KICK_REACH);
  });
});

describe('ending it', () => {
  test('a release lets it roll on with the dribbler, from the hand', () => {
    const { person, ball } = spawnSpot();
    setUp([person], ball);
    lobby.dribble('A');
    step();
    const dir = Math.cos(person.angle);
    pose('A', person.x + dir * 0.1, person.y, person.angle);
    step();
    lobby.release('A');
    step();
    const loose = lastBall('A');
    expect(loose.heldBy).toBeUndefined();
    expect(dir * (loose.vx ?? 0)).toBeGreaterThan(0.5);
  });

  test("the dribbler's kick throws it from the hand, echoed as a kick", () => {
    const { person, ball } = spawnSpot();
    const [a] = setUp([person], ball);
    lobby.dribble('A');
    step();
    time += BALL_KICK_GAP_MS;
    lobby.kick('A', { type: 'kick', angle: person.angle, k: 1 });
    step();
    const thrown = lastBall('A');
    expect(thrown).toMatchObject({ event: 'kick', by: a, k: 1 });
    expect(thrown.heldBy).toBeUndefined();
    expect(Math.hypot(thrown.vx ?? 0, thrown.vy ?? 0)).toBeGreaterThan(BALL_KICK_SPEED - 0.5);
  });

  test('a throw too soon after the last kick is refused and the ball stays held', () => {
    const { person, ball } = spawnSpot();
    const [a] = setUp([person], ball);
    lobby.kick('A', { type: 'kick', angle: person.angle + Math.PI, k: 1 });
    lobby.dribble('A');
    step();
    lobby.kick('A', { type: 'kick', angle: person.angle, k: 2 });
    step();
    expect(sent.some((s) => s.conn === 'A' && s.msg.type === 'kick_refused' && s.msg.k === 2)).toBe(true);
    expect(lastBall('A').heldBy).toBe(a);
  });

  test("another person's kick steals it", () => {
    const { person, ball } = spawnSpot();
    const there = hand(person);
    const [, b] = setUp([person, { x: there.x, y: there.y + 0.6 }], ball);
    lobby.dribble('A');
    step();
    lobby.kick('B', { type: 'kick', angle: Math.PI / 2, k: 1 });
    step();
    const stolen = lastBall('A');
    expect(stolen).toMatchObject({ event: 'kick', by: b });
    expect(stolen.heldBy).toBeUndefined();
  });

  test('the hold survives a dropped connection and ends when the person expires', () => {
    const { person, ball } = spawnSpot();
    const [a] = setUp([person, { x: person.x, y: person.y + 0.6 }], ball, { ball: true, graceMs: 1000 });
    lobby.dribble('A');
    step();
    lobby.disconnect('A');
    step(5);
    expect(lastBall('B').heldBy).toBe(a);
    time += 1000;
    lobby.tick();
    step();
    expect(lastBall('B').heldBy).toBeUndefined();
  });

  test('a snapshot saves a held ball loose', () => {
    const { person, ball } = spawnSpot();
    setUp([person], ball);
    lobby.dribble('A');
    step();
    const snap = JSON.parse(JSON.stringify(lobby.snapshot())) as LobbySnapshot;
    lobby = makeLobby({ ball: true });
    lobby.restore(snap);
    join('C');
    const w = defined(sent.filter((s) => s.conn === 'C' && s.msg.type === 'welcome').at(-1)?.msg, 'welcome');
    expect(w.type === 'welcome' && w.objects.find((o) => o.kind === 'ball')?.heldBy).toBeUndefined();
  });
});
