// Server tick cost (`pnpm bench:tick`): Lobby.stepWorld + fanOut on LEVEL1 with one room of 100 bots and a few or many
// connected people walking about, with the room's portals off and on. No sockets and no JSON, so serialisation is not
// counted. D27 records the numbers.
import { FANOUT_TICK_MS, isWallAt, LEVEL1, PROTOCOL_VERSION, parseMap } from '@zoom3d/shared';
import { Lobby } from '../src/lobby';

const map = parseMap(LEVEL1);
const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const BOTS = 100;
const CROWDS = [4, 100];
const WARMUP_TICKS = 100;
const TICKS = 600;
const WALK_PER_TICK = 0.2;

function run(people: number, portalsOn: boolean): void {
  let time = 1_000_000;
  let n = 0;
  const lobby = new Lobby({
    map,
    out: { send: () => {}, broadcast: () => {}, close: () => {} },
    now: () => time,
    rng: Math.random,
    newToken: () => `t${++n}`,
    liveKitFor: () => ({ url: 'ws://lk', token: 't' }),
    vacuum: true,
    ball: true,
  });
  let seed = 5;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const walkers: { conn: string; x: number; y: number; angle: number; seq: number }[] = [];
  for (let i = 0; i < people; i++) {
    const conn = `c${i}`;
    lobby.join(conn, {
      type: 'join',
      v: PROTOCOL_VERSION,
      roomId: ROOM,
      name: conn,
      ...(i === 0 ? { bots: BOTS } : {}),
    });
    walkers.push({ conn, x: map.spawn.x + 0.5, y: map.spawn.y + 0.5, angle: rand() * Math.PI * 2, seq: 0 });
  }
  time += 1100;
  if (portalsOn) {
    lobby.portals('c0');
  }
  const stepMs: number[] = [];
  const fanOutMs: number[] = [];
  for (let t = 0; t < WARMUP_TICKS + TICKS; t++) {
    time += FANOUT_TICK_MS;
    for (const w of walkers) {
      const nx = w.x + Math.cos(w.angle) * WALK_PER_TICK;
      const ny = w.y + Math.sin(w.angle) * WALK_PER_TICK;
      if (isWallAt(map, nx, ny)) {
        w.angle += 1 + rand();
      } else {
        w.x = nx;
        w.y = ny;
        w.angle += (rand() - 0.5) * 0.3;
      }
      lobby.state(w.conn, { type: 'state', x: w.x, y: w.y, angle: w.angle, seq: ++w.seq });
    }
    const start = performance.now();
    lobby.stepWorld(FANOUT_TICK_MS);
    const stepped = performance.now();
    lobby.fanOut();
    const done = performance.now();
    if (t >= WARMUP_TICKS) {
      stepMs.push(stepped - start);
      fanOutMs.push(done - stepped);
    }
  }
  console.log(`${people} connected + ${BOTS} bots, portals ${portalsOn ? 'on ' : 'off'}`);
  console.log(`  stepWorld ${describe(stepMs)}`);
  console.log(`  fanOut    ${describe(fanOutMs)}`);
}

function describe(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const at = (q: number) => (sorted.at(Math.floor(sorted.length * q)) ?? Number.NaN).toFixed(2);
  return `mean ${mean.toFixed(2)} p50 ${at(0.5)} p99 ${at(0.99)} max ${(sorted.at(-1) ?? Number.NaN).toFixed(2)} ms`;
}

for (const people of CROWDS) {
  run(people, false);
  run(people, true);
}
