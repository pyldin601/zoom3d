// HTTP + WebSocket transport around the Lobby: rate limit, size cap, heartbeat, grace ticking, logs and metrics.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LEVEL1, MAX_MESSAGE_BYTES, parseClientMessage, parseMap, RATE_BURST, RATE_PER_SEC } from '@zoom3d/shared';
import { type WebSocket, WebSocketServer } from 'ws';
import { type IceConfig, iceConfigFromEnv, iceServersFor } from './ice';
import { Lobby, type LobbyEvent, type Outbox } from './lobby';
import { type Logger, silentLogger } from './log';
import { createMetrics, type Metrics } from './metrics';
import { createTokenBucket } from './rate-limit';
import { loadSnapshot, saveSnapshot } from './snapshot';

export const CLOSE_RATE_LIMIT = 4008;
const MAX_CONSECUTIVE_DROPS = 200;
const TICK_MS = 1000;

export interface ServerOptions {
  port: number;
  graceMs?: number;
  heartbeatMs?: number;
  ice?: IceConfig;
  /** Where the lobby is saved on close and restored from on start; unset keeps it in memory only. */
  stateFile?: string;
  /** Clock for the per-socket rate limit; defaults to `Date.now`. Tests freeze it. */
  rateLimitClock?: () => number;
  /** Defaults to silent, so tests stay quiet. */
  log?: Logger;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/**
 * A room id is the room's only key (anyone with the link walks in), so logs carry a short hash of it instead:
 * enough to follow one room through the logs, useless for joining it.
 */
export function roomRef(roomId: string): string {
  return createHash('sha256').update(roomId).digest('base64url').slice(0, 10);
}

/** Every lobby event becomes one log line and feeds the counters. */
function observe(e: LobbyEvent, log: Logger, metrics: Metrics): void {
  switch (e.type) {
    case 'room_opened':
    case 'room_closed':
      log.info(e.type, { room: roomRef(e.roomId) });
      break;
    case 'joined': {
      const { type: _, roomId, ...fields } = e;
      log.info('peer_joined', { room: roomRef(roomId), ...fields });
      metrics.joins.inc({ result: e.resumed ? 'resumed' : 'new' });
      break;
    }
    case 'rejected':
      log.info('join_rejected', { reason: e.reason });
      metrics.joins.inc({ result: e.reason });
      break;
    case 'disconnected':
      log.info('peer_disconnected', { room: roomRef(e.roomId), peerId: e.peerId });
      break;
    case 'left':
      log.info('peer_left', { room: roomRef(e.roomId), peerId: e.peerId, peers: e.peers });
      metrics.peersLeft.inc();
      break;
    case 'move_corrected':
      log.debug('move_corrected', { room: roomRef(e.roomId), peerId: e.peerId });
      metrics.moveCorrections.inc();
      break;
  }
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const ice = opts.ice ?? iceConfigFromEnv({});
  const log = opts.log ?? silentLogger;
  const sockets = new Map<string, { ws: WebSocket; alive: boolean }>();
  const out: Outbox = {
    send(conn, msg) {
      const s = sockets.get(conn);
      if (s && s.ws.readyState === s.ws.OPEN) {
        s.ws.send(JSON.stringify(msg));
      }
    },
    close(conn, code, reason) {
      sockets.get(conn)?.ws.close(code, reason);
    },
  };
  // Gauges read the lobby lazily at scrape time; `lobby` is assigned before any scrape can happen.
  const metrics = createMetrics({ connections: () => sockets.size, lobby: () => lobby.stats() });
  const lobby = new Lobby({
    map: parseMap(LEVEL1),
    out,
    now: Date.now,
    rng: Math.random,
    newToken: () => randomBytes(12).toString('base64url'),
    graceMs: opts.graceMs,
    iceServersFor: (peerId) => iceServersFor(ice, peerId, Date.now()),
    onEvent: (e) => observe(e, log, metrics),
  });
  const restored = opts.stateFile ? loadSnapshot(opts.stateFile, log) : null;
  if (restored) {
    lobby.restore(restored);
    const peers = restored.rooms.reduce((n, r) => n + r.peers.length, 0);
    log.info('snapshot_restored', { rooms: restored.rooms.length, peers });
  }

  // Not routed publicly: Traefik and the web nginx only forward /ws to this server.
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    } else if (req.method === 'GET' && req.url === '/metrics') {
      metrics.registry.metrics().then(
        (body) => res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(body),
        (err) => {
          log.error('metrics_failed', { err });
          res.writeHead(500).end();
        }
      );
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws) => {
    const conn = randomUUID();
    const openedAt = Date.now();
    const entry = { ws, alive: true };
    sockets.set(conn, entry);
    metrics.connectionsOpened.inc();
    log.debug('connection_opened', { conn });
    const bucket = createTokenBucket(RATE_PER_SEC, RATE_BURST, opts.rateLimitClock ?? Date.now);
    let drops = 0;
    ws.on('pong', () => {
      entry.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (!bucket.take()) {
        metrics.messagesDropped.inc({ reason: 'rate_limit' });
        if (++drops === MAX_CONSECUTIVE_DROPS) {
          log.warn('rate_limited', { conn, drops });
          metrics.connectionsTerminated.inc({ reason: 'rate_limit' });
          ws.close(CLOSE_RATE_LIMIT, 'rate');
        }
        return;
      }
      drops = 0;
      if (isBinary) {
        metrics.messagesDropped.inc({ reason: 'binary' });
        return;
      }
      const msg = parseClientMessage(String(data));
      if (msg === null) {
        metrics.messagesDropped.inc({ reason: 'invalid' });
        log.debug('message_invalid', { conn, bytes: (data as Buffer).length });
        return;
      }
      metrics.messages.inc({ type: msg.type });
      if (msg.type === 'join') {
        lobby.join(conn, msg);
      } else if (msg.type === 'state') {
        lobby.state(conn, msg);
      } else if (msg.type === 'media') {
        lobby.media(conn, msg);
      } else if (msg.type === 'held') {
        lobby.held(conn, msg);
      } else if (msg.type === 'drink') {
        lobby.drink(conn);
      } else if (msg.type === 'cheers') {
        lobby.cheers(conn);
      } else if (msg.type === 'boombox') {
        lobby.boombox(conn, msg);
      } else if (msg.type === 'signal') {
        lobby.signal(conn, msg);
      }
    });
    // The close reason is client-chosen text, so only the code is logged.
    ws.on('close', (code) => {
      sockets.delete(conn);
      log.info('connection_closed', { conn, code, durationMs: Date.now() - openedAt });
      lobby.disconnect(conn);
    });
    ws.on('error', (err) => {
      // A protocol error closes the socket; 'close' cleans up.
      log.debug('connection_error', { conn, error: err.message });
    });
  });

  const heartbeat = setInterval(() => {
    for (const s of sockets.values()) {
      if (!s.alive) {
        metrics.connectionsTerminated.inc({ reason: 'heartbeat' });
        s.ws.terminate();
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }, opts.heartbeatMs ?? 10_000);
  const ticker = setInterval(() => lobby.tick(), TICK_MS);

  await new Promise<void>((resolve) => http.listen(opts.port, resolve));
  return {
    port: (http.address() as AddressInfo).port,
    async close() {
      clearInterval(heartbeat);
      clearInterval(ticker);
      if (opts.stateFile) {
        saveSnapshot(opts.stateFile, lobby.snapshot(), log);
      }
      for (const s of sockets.values()) {
        s.ws.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
