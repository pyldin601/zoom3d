// Multiplayer session: remote peers with interpolation buffers, corrections, and timer-driven state sync.
import {
  type ErrorCode,
  IDLE_INTERVAL_MS,
  type PeerInfo,
  type PlayerState,
  type ServerMessage,
  SnapshotBuffer,
  STATE_INTERVAL_MS,
} from '@zoom3d/shared';
import { type ConnStatus, connect } from './connection';

const MOVE_EPSILON = 1e-4;
const TURN_EPSILON = 1e-3;

export interface RemotePeer {
  info: PeerInfo;
  buffer: SnapshotBuffer;
  lastSeq: number;
}

export interface Session {
  peers: Map<string, RemotePeer>;
  selfId(): string | null;
  selfColor(): string | null;
  status(): ConnStatus;
  error(): ErrorCode | null;
  close(): void;
}

export interface SessionOptions {
  url: string;
  roomId: string;
  name: string;
  /** Mutated in place by spawn and corrections; read by the state sender. */
  player: PlayerState;
  now: () => number;
  WebSocketImpl?: typeof WebSocket;
}

export function createSession(opts: SessionOptions): Session {
  const { player, now } = opts;
  const peers = new Map<string, RemotePeer>();
  let selfId: string | null = null;
  let color: string | null = null;
  let resumeToken: string | undefined;
  let status: ConnStatus = 'connecting';
  let error: ErrorCode | null = null;
  let welcomed = false;
  let seq = 0;
  const lastSent = { x: Number.NaN, y: Number.NaN, angle: Number.NaN, at: 0 };

  const addPeer = (info: PeerInfo) => {
    const buffer = new SnapshotBuffer();
    buffer.push({ t: now(), x: info.x, y: info.y, angle: info.angle });
    peers.set(info.id, { info: { ...info }, buffer, lastSeq: -1 });
  };

  const handle = (m: ServerMessage) => {
    switch (m.type) {
      case 'welcome':
        if (!welcomed) {
          Object.assign(player, m.spawn);
          welcomed = true;
        }
        selfId = m.selfId;
        color = m.color;
        resumeToken = m.resumeToken;
        peers.clear();
        for (const p of m.peers) addPeer(p);
        Object.assign(lastSent, { x: player.x, y: player.y, angle: player.angle, at: now() });
        break;
      case 'peer_joined':
        addPeer(m.peer);
        break;
      case 'peer_left':
        peers.delete(m.id);
        break;
      case 'peer_state': {
        const peer = peers.get(m.id);
        if (!peer || m.seq <= peer.lastSeq) return;
        peer.lastSeq = m.seq;
        Object.assign(peer.info, { x: m.x, y: m.y, angle: m.angle });
        peer.buffer.push({ t: now(), x: m.x, y: m.y, angle: m.angle });
        break;
      }
      case 'correction':
        Object.assign(player, { x: m.x, y: m.y, angle: m.angle });
        break;
      case 'error':
        error = m.code;
        break;
    }
  };

  const conn = connect({
    url: opts.url,
    makeJoin: () => ({
      type: 'join',
      roomId: opts.roomId,
      name: opts.name,
      ...(resumeToken ? { resumeToken } : {}),
    }),
    onMessage: handle,
    onStatus: (s) => {
      status = s;
    },
    WebSocketImpl: opts.WebSocketImpl,
  });

  // A timer (not rAF) so position heartbeats continue while the tab is hidden.
  const sender = setInterval(() => {
    if (status !== 'open') return;
    const t = now();
    const moved =
      Math.abs(player.x - lastSent.x) > MOVE_EPSILON ||
      Math.abs(player.y - lastSent.y) > MOVE_EPSILON ||
      Math.abs(player.angle - lastSent.angle) > TURN_EPSILON;
    if (!moved && t - lastSent.at < IDLE_INTERVAL_MS) return;
    seq++;
    conn.send({ type: 'state', x: player.x, y: player.y, angle: player.angle, seq });
    Object.assign(lastSent, { x: player.x, y: player.y, angle: player.angle, at: t });
  }, STATE_INTERVAL_MS);

  return {
    peers,
    selfId: () => selfId,
    selfColor: () => color,
    status: () => status,
    error: () => error,
    close() {
      clearInterval(sender);
      conn.close();
    },
  };
}
