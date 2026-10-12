import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarPath, PROTOCOL_VERSION, parseServerMessage, type ServerMessage } from '@zoom3d/shared';
import { afterEach, beforeEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { Logger } from './log';
import { roomRef, startServer } from './server';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
let server: Awaited<ReturnType<typeof startServer>>;
const clients: WebSocket[] = [];

beforeEach(async () => {
  server = await startServer({ port: 0, graceMs: 200, heartbeatMs: 100 });
});

afterEach(async () => {
  for (const c of clients.splice(0)) {
    c.terminate();
  }
  await server.close();
});

interface TestClient {
  ws: WebSocket;
  messages: ServerMessage[];
  closed: Promise<number>;
  send(v: unknown): void;
  sendRaw(raw: string): void;
  waitFor<T extends ServerMessage['type']>(type: T, after?: number): Promise<Extract<ServerMessage, { type: T }>>;
}

async function client(): Promise<TestClient> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  clients.push(ws);
  const messages: ServerMessage[] = [];
  ws.on('message', (data) => {
    const msg = parseServerMessage(String(data));
    if (msg) {
      messages.push(msg);
    }
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    messages,
    closed,
    send: (v) => ws.send(JSON.stringify(v)),
    sendRaw: (raw) => ws.send(raw),
    async waitFor(type, after = 0) {
      for (let i = 0; i < 200; i++) {
        const found = messages.slice(after).find((m) => m.type === type);
        if (found) {
          return found as never;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${type}`);
    },
  };
}

async function joined(name: string) {
  const c = await client();
  c.send({ type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name });
  const welcome = await c.waitFor('welcome');
  return { ...c, welcome };
}

test('health check', async () => {
  const res = await fetch(`http://localhost:${server.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('ok');
  expect((await fetch(`http://localhost:${server.port}/nope`)).status).toBe(404);
});

async function metrics(): Promise<string> {
  const res = await fetch(`http://localhost:${server.port}/metrics`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
}

function captureLog() {
  const lines: { level: string; msg: string; [k: string]: unknown }[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
    lines.push({ ...fields, level, msg });
  const log: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  return { log, lines };
}

test('metrics count what the server sends: messages and bytes by type, each delivery once', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  const { x, y } = a.welcome.spawn;
  a.send({ type: 'state', x, y, angle: 1, seq: 1 });
  await b.waitFor('peers');
  const text = await metrics();
  expect(text).toContain('zoom3d_messages_sent_total{type="welcome"} 2');
  expect(text).toContain('zoom3d_messages_sent_total{type="peer_joined"} 1');
  expect(text).toContain('zoom3d_messages_sent_total{type="peers"} 1');
  const bytes = /zoom3d_bytes_sent_total\{type="peers"\} (\d+)/.exec(text)?.[1];
  expect(Number(bytes)).toBeGreaterThan(20);
  expect(text).toContain('zoom3d_peers_batch_entries_bucket{le="1"} 1');
  expect(text).toContain('zoom3d_peers_batch_entries_count 1');
});

test('metrics count rooms, peers, joins and dropped messages', async () => {
  const a = await joined('Ada');
  await joined('Bob');
  a.sendRaw('not json');
  a.ws.send(Buffer.from([1, 2, 3]));
  const { x, y } = a.welcome.spawn;
  a.send({ type: 'state', x, y, angle: 1, seq: 1 });
  a.send({ type: 'state', x: x + 50, y, angle: 1, seq: 2 });
  await new Promise((r) => setTimeout(r, 50));
  const text = await metrics();
  expect(text).toContain('zoom3d_connections 2');
  expect(text).toContain('zoom3d_rooms 1');
  expect(text).toContain('zoom3d_peers{state="connected"} 2');
  expect(text).toContain('zoom3d_joins_total{result="new"} 2');
  expect(text).toContain('zoom3d_messages_total{type="join"} 2');
  expect(text).toContain('zoom3d_messages_total{type="state"} 2');
  expect(text).toContain('zoom3d_messages_dropped_total{reason="invalid"} 1');
  expect(text).toContain('zoom3d_messages_dropped_total{reason="binary"} 1');
  expect(text).toContain('zoom3d_move_corrections_total 1');
  expect(text).toContain('process_cpu_user_seconds_total');
});

test('lobby events and connection ends are logged without names, tokens or room ids', async () => {
  await server.close();
  const { log, lines } = captureLog();
  server = await startServer({ port: 0, graceMs: 50, heartbeatMs: 100, log });
  const a = await joined('Ada');
  a.ws.close();
  // The lobby ticks once a second.
  await expect.poll(() => lines.map((l) => l.msg), { timeout: 3000 }).toContain('room_closed');
  const msgs = lines.map((l) => l.msg);
  expect(msgs).toEqual(
    expect.arrayContaining(['room_opened', 'peer_joined', 'connection_closed', 'peer_disconnected', 'peer_left'])
  );
  expect(lines.find((l) => l.msg === 'peer_joined')).toMatchObject({ room: roomRef(ROOM), peerId: a.welcome.selfId });
  const all = JSON.stringify(lines);
  expect(all).not.toContain(ROOM);
  expect(all).not.toContain('Ada');
  expect(all).not.toContain(a.welcome.resumeToken);
});

test('two clients see each other and state arrives in batches', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  expect((await a.waitFor('peer_joined')).peer.name).toBe('Bob');
  expect(b.welcome.peers.map((p) => p.name)).toEqual(['Ada']);
  const { x, y } = a.welcome.spawn;
  a.send({ type: 'state', x, y, angle: 1, seq: 1 });
  const slot = b.welcome.peers[0]?.slot;
  expect((await b.waitFor('peers')).s).toEqual([[slot, Math.round(x * 100) / 100, Math.round(y * 100) / 100, 1]]);
});

test('a join without a protocol version (a tab from before 6d) is refused as invalid_room', async () => {
  const c = await client();
  c.send({ type: 'join', roomId: ROOM, name: 'Old' });
  expect(await c.waitFor('error')).toMatchObject({ code: 'invalid_room' });
  expect(await c.closed).toBe(4002);
});

test('avatars are served by id, cacheable forever, and unknown ones are 404', async () => {
  const pic = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  const c = await client();
  c.send({ type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name: 'Ada', avatar: pic });
  await c.waitFor('welcome');
  const b = await joined('Bob');
  const id = b.welcome.peers[0]?.avatar;
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const res = await fetch(`http://localhost:${server.port}${avatarPath(id as string)}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from('/9j/4AAQSkZJRgABAQ==', 'base64'));
  expect((await fetch(`http://localhost:${server.port}/avatar/AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
  expect((await fetch(`http://localhost:${server.port}/avatar/a/b`)).status).toBe(404);
});

test('garbage from one client is dropped and the room keeps working', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  a.sendRaw('not json');
  a.send({ type: 'nope' });
  a.send({ type: 'state', x: '1', y: 2, angle: 0, seq: 0 });
  const { x, y } = a.welcome.spawn;
  a.send({ type: 'state', x, y, angle: 2, seq: 2 });
  expect((await b.waitFor('peers')).s[0]?.[3]).toBe(2);
});

test('an oversized message closes only the offender', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  const c = await client();
  c.sendRaw('x'.repeat(20_000));
  expect(await c.closed).toBe(1009);
  const { x, y } = a.welcome.spawn;
  a.send({ type: 'state', x, y, angle: 3, seq: 3 });
  expect((await b.waitFor('peers')).s[0]?.[3]).toBe(3);
});

test('a flood is rate limited and finally closed with 4008', async () => {
  // A frozen rate-limit clock: the bucket never refills, however long the flood takes to process.
  // On the real clock one refilled token (1/60 s) resets the drop streak and the socket never closes.
  await server.close();
  const { log, lines } = captureLog();
  server = await startServer({ port: 0, graceMs: 200, heartbeatMs: 100, rateLimitClock: () => 0, log });
  const a = await joined('Ada');
  const b = await joined('Bob');
  const { x, y } = a.welcome.spawn;
  for (let i = 0; i < 400; i++) {
    if (i === 200) {
      await new Promise((r) => setTimeout(r, 50));
    }
    a.send({ type: 'state', x, y, angle: 0, seq: 10 + i });
  }
  expect(await a.closed).toBe(4008);
  // The flood never reaches Bob as a flood: at most one batch per tick, and only when Ada's pose changed.
  await joined('Cy');
  await b.waitFor('peer_joined');
  expect(b.messages.filter((m) => m.type === 'peers').length).toBeLessThanOrEqual(2);
  expect(b.ws.readyState).toBe(WebSocket.OPEN);
  expect(lines.find((l) => l.msg === 'rate_limited')?.level).toBe('warn');
  const text = await metrics();
  expect(text).toContain('zoom3d_connections_terminated_total{reason="rate_limit"} 1');
  expect(text).toMatch(/zoom3d_messages_dropped_total\{reason="rate_limit"\} [1-9]/);
});

test('a vanished client is announced as left after the grace period', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  b.ws.terminate();
  expect((await a.waitFor('peer_left')).id).toBe(b.welcome.selfId);
});

test('the welcome hands out LiveKit access (dev defaults) and signal messages are not relayed', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  const raw: string[] = [];
  b.ws.on('message', (data) => raw.push(String(data)));
  expect(b.welcome.livekit.url).toBe('ws://localhost:7880');
  expect(b.welcome.livekit.token.split('.')).toHaveLength(3);
  a.send({ type: 'signal', to: b.welcome.selfId, payload: { kind: 'candidate', candidate: null } });
  a.send({ type: 'held', item: null });
  // Messages are handled in order: once the held relay arrives, a relayed signal would already have.
  await b.waitFor('peer_held');
  expect(raw.some((m) => m.includes('"signal"'))).toBe(false);
});

test('a room created with bots shows them, keeps them moving, and counts them on /metrics', async () => {
  const c = await client();
  c.send({ type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name: 'Ada', bots: 5 });
  const welcome = await c.waitFor('welcome');
  const botSlots = new Set(welcome.peers.map((p) => p.slot));
  expect(welcome.peers.map((p) => p.name)).toEqual(['Bot 001', 'Bot 002', 'Bot 003', 'Bot 004', 'Bot 005']);
  const batch = await c.waitFor('peers');
  expect(batch.s.every(([slot]) => botSlots.has(slot))).toBe(true);
  expect(await metrics()).toContain('zoom3d_peers{state="bot"} 5');
});

test('held is relayed over real sockets', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  a.send({ type: 'held', item: 'coffee' });
  expect(await b.waitFor('peer_held')).toEqual({ type: 'peer_held', id: a.welcome.selfId, item: 'coffee' });
});

test('boombox is relayed over real sockets', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  a.send({ type: 'boombox', on: true });
  expect(await b.waitFor('peer_boombox')).toEqual({ type: 'peer_boombox', id: a.welcome.selfId, on: true });
});

test('sips are relayed over real sockets', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  a.send({ type: 'held', item: 'coffee' });
  await b.waitFor('peer_held');
  a.send({ type: 'drink' });
  expect(await b.waitFor('peer_drink')).toEqual({ type: 'peer_drink', id: a.welcome.selfId });
});

test('cheers are relayed over real sockets', async () => {
  const a = await joined('Ada');
  const b = await joined('Bob');
  a.send({ type: 'held', item: 'beer' });
  await b.waitFor('peer_held');
  a.send({ type: 'cheers' });
  expect(await b.waitFor('peer_cheers')).toEqual({ type: 'peer_cheers', id: a.welcome.selfId });
});

test('rooms survive a restart through the state file', async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'zoom3d-state-')), 'lobby.json');
  await server.close();
  server = await startServer({ port: 0, graceMs: 200, heartbeatMs: 100, stateFile });
  const a = await joined('Ada');
  const b = await joined('Bob');
  a.send({ type: 'held', item: 'wine' });
  await b.waitFor('peer_held');
  await server.close();
  expect(existsSync(stateFile)).toBe(true);

  server = await startServer({ port: 0, graceMs: 200, heartbeatMs: 100, stateFile });
  expect(existsSync(stateFile)).toBe(false);
  const a2 = await client();
  a2.send({ type: 'join', v: PROTOCOL_VERSION, roomId: ROOM, name: 'Ada', resumeToken: a.welcome.resumeToken });
  const welcome = await a2.waitFor('welcome');
  expect(welcome.selfId).toBe(a.welcome.selfId);
  expect(welcome.color).toBe(a.welcome.color);
  expect(welcome.peers.map((p) => p.id)).toEqual([b.welcome.selfId]);
  const c = await joined('Cy');
  expect(c.welcome.peers.find((p) => p.id === a.welcome.selfId)?.held).toBe('wine');
  // Bob never came back: his restored slot expires after the grace period.
  expect((await a2.waitFor('peer_left')).id).toBe(b.welcome.selfId);
});
