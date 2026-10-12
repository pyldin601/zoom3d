// Game-socket load: N real clients join one room and walk the map at player speed, sending state at 15 Hz like the
// browser does, and count what they receive. Usage: swarm.mts <wsUrl> <roomId> <n> <seconds>
import { randomBytes } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();

import { LEVEL1, parseMap, STATE_INTERVAL_MS, stepPlayer } from '@zoom3d/shared';

const [url, roomId, nArg, secArg] = process.argv.slice(2);
const N = Number(nArg);
const SECONDS = Number(secArg);
const map = parseMap(LEVEL1);

interface Bot {
  ws: WebSocket;
  pose: { x: number; y: number; angle: number } | null;
  seq: number;
  turn: number;
  msgs: number;
  bytes: number;
  peersMsgs: number;
  entries: number;
  maxGap: number;
  lastPeersAt: number;
  corrections: number;
  errors: string[];
  sent: number;
  bunched: number;
  gaps: number[];
}
const bots: Bot[] = [];
const started = Date.now();

function spawn(i: number): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const b: Bot = {
      ws,
      pose: null,
      seq: 0,
      turn: 0,
      msgs: 0,
      bytes: 0,
      peersMsgs: 0,
      entries: 0,
      maxGap: 0,
      lastPeersAt: 0,
      corrections: 0,
      errors: [],
      sent: 0,
      bunched: 0,
      gaps: [],
    };
    bots.push(b);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'join',
          v: 2,
          roomId,
          name: `Load ${String(i + 1).padStart(3, '0')}`,
          avatar: `data:image/jpeg;base64,${randomBytes(600).toString('base64')}`,
        })
      );
    ws.onmessage = (e) => {
      const raw = String(e.data);
      const m = JSON.parse(raw);
      b.msgs++;
      b.bytes += raw.length;
      if (m.type === 'welcome') {
        b.pose = { ...m.spawn };
        resolve();
      } else if (m.type === 'peers') {
        const now = Date.now();
        if (b.lastPeersAt) {
          const gap = now - b.lastPeersAt;
          b.maxGap = Math.max(b.maxGap, gap);
          b.gaps.push(gap);
          if (gap < 15) {
            b.bunched++;
          }
        }
        b.lastPeersAt = now;
        b.peersMsgs++;
        b.entries += m.s.length;
      } else if (m.type === 'correction') {
        b.corrections++;
        b.pose = { x: m.x, y: m.y, angle: m.angle };
      } else if (m.type === 'error') {
        b.errors.push(m.code);
        resolve();
      }
    };
    ws.onerror = () => {
      b.errors.push('socket');
      resolve();
    };
  });
}

// Join 10 per second, like people arriving.
for (let i = 0; i < N; i++) {
  void spawn(i);
  if (i % 10 === 9) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await new Promise((r) => setTimeout(r, 2000));
console.log(
  `joined ${bots.filter((b) => b.pose).length}/${N}, errors: ${bots.flatMap((b) => b.errors).join(',') || 'none'}`
);

const out = { x: 0, y: 0, angle: 0 };
const walker = setInterval(() => {
  for (const b of bots) {
    if (!b.pose || b.ws.readyState !== 1) {
      continue;
    }
    if (Math.random() < 0.02) {
      b.turn = Math.random() < 0.5 ? (Math.random() - 0.5) * 2 : 0;
    }
    stepPlayer(map, b.pose, { forward: 1, strafe: 0, turn: b.turn }, STATE_INTERVAL_MS / 1000, out);
    if (Math.hypot(out.x - b.pose.x, out.y - b.pose.y) < 0.05) {
      out.angle = Math.random() * Math.PI * 2;
    }
    b.pose = { x: out.x, y: out.y, angle: out.angle };
    b.ws.send(JSON.stringify({ type: 'state', ...b.pose, seq: ++b.seq }));
    b.sent++;
  }
}, STATE_INTERVAL_MS);

const pct = (xs: number[], p: number) =>
  xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? NaN;
let window0 = bots.map((b) => ({ msgs: b.msgs, bytes: b.bytes, peers: b.peersMsgs, entries: b.entries }));
let t0 = Date.now();
const report = setInterval(() => {
  const dt = (Date.now() - t0) / 1000;
  const rates = bots.map((b, i) => ({
    msgs: (b.msgs - window0[i].msgs) / dt,
    kbps: ((b.bytes - window0[i].bytes) * 8) / dt / 1000,
    entries: b.peersMsgs > window0[i].peers ? (b.entries - window0[i].entries) / (b.peersMsgs - window0[i].peers) : 0,
  }));
  const live = bots.filter((b) => b.ws.readyState === 1).length;
  console.log(
    `t=${Math.round((Date.now() - started) / 1000)}s live=${live} msg/s p50=${pct(
      rates.map((r) => r.msgs),
      0.5
    ).toFixed(1)} ` +
      `kbit/s p50=${pct(
        rates.map((r) => r.kbps),
        0.5
      ).toFixed(0)} p95=${pct(
        rates.map((r) => r.kbps),
        0.95
      ).toFixed(0)} ` +
      `entries/batch p50=${pct(
        rates.map((r) => r.entries),
        0.5
      ).toFixed(1)} max batch gap p95=${pct(
        bots.map((b) => b.maxGap),
        0.95
      )}ms ` +
      `corrections=${bots.reduce((n, b) => n + b.corrections, 0)} sent/s=${(bots.reduce((n, b) => n + b.sent, 0) / dt).toFixed(0)} ` +
      `clientLagMax=${Math.round(lag.max / 1e6)}ms rssMiB=${Math.round(process.memoryUsage().rss / 2 ** 20)} ` +
      `bunched=${bots.reduce((n, b) => n + b.bunched, 0)} gaps>600ms=${bots.reduce((n, b) => n + b.gaps.filter((g) => g > 600).length, 0)}`
  );
  lag.reset();
  window0 = bots.map((b) => ({ msgs: b.msgs, bytes: b.bytes, peers: b.peersMsgs, entries: b.entries }));
  t0 = Date.now();
  for (const b of bots) {
    b.maxGap = 0;
    b.sent = 0;
    b.bunched = 0;
    b.gaps = [];
  }
}, 10_000);

setTimeout(() => {
  clearInterval(walker);
  clearInterval(report);
  for (const b of bots) {
    b.ws.close();
  }
  setTimeout(() => process.exit(0), 500);
}, SECONDS * 1000);
