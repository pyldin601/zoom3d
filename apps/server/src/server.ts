// HTTP + WebSocket transport around the Lobby: rate limit, size cap, heartbeat, grace ticking.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LEVEL1, MAX_MESSAGE_BYTES, parseClientMessage, parseMap, RATE_BURST, RATE_PER_SEC } from '@zoom3d/shared';
import { type WebSocket, WebSocketServer } from 'ws';
import { type IceConfig, iceConfigFromEnv, iceServersFor } from './ice';
import { Lobby, type Outbox } from './lobby';
import { createTokenBucket } from './rate-limit';

export const CLOSE_RATE_LIMIT = 4008;
const MAX_CONSECUTIVE_DROPS = 200;
const TICK_MS = 1000;

export interface ServerOptions {
  port: number;
  graceMs?: number;
  heartbeatMs?: number;
  ice?: IceConfig;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const ice = opts.ice ?? iceConfigFromEnv({});
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
  const lobby = new Lobby({
    map: parseMap(LEVEL1),
    out,
    now: Date.now,
    rng: Math.random,
    newToken: () => randomBytes(12).toString('base64url'),
    graceMs: opts.graceMs,
    iceServersFor: (peerId) => iceServersFor(ice, peerId, Date.now()),
  });

  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws) => {
    const conn = randomUUID();
    const entry = { ws, alive: true };
    sockets.set(conn, entry);
    const bucket = createTokenBucket(RATE_PER_SEC, RATE_BURST, Date.now);
    let drops = 0;
    ws.on('pong', () => {
      entry.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (!bucket.take()) {
        if (++drops >= MAX_CONSECUTIVE_DROPS) {
          ws.close(CLOSE_RATE_LIMIT, 'rate');
        }
        return;
      }
      drops = 0;
      if (isBinary) {
        return;
      }
      const msg = parseClientMessage(String(data));
      if (msg?.type === 'join') {
        lobby.join(conn, msg);
      } else if (msg?.type === 'state') {
        lobby.state(conn, msg);
      } else if (msg?.type === 'media') {
        lobby.media(conn, msg);
      } else if (msg?.type === 'held') {
        lobby.held(conn, msg);
      } else if (msg?.type === 'signal') {
        lobby.signal(conn, msg);
      }
    });
    ws.on('close', () => {
      sockets.delete(conn);
      lobby.disconnect(conn);
    });
    ws.on('error', () => {
      // A protocol error closes the socket; 'close' cleans up.
    });
  });

  const heartbeat = setInterval(() => {
    for (const s of sockets.values()) {
      if (!s.alive) {
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
      for (const s of sockets.values()) {
        s.ws.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
