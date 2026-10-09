// Multiplayer session: remote peers with interpolation buffers, corrections, and timer-driven state sync.
import {
  type ErrorCode,
  type HeldItem,
  type IceServer,
  IDLE_INTERVAL_MS,
  type PeerInfo,
  type PlayerState,
  type ServerMessage,
  type SignalPayload,
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

/** Notified after the session has applied each server event to its own state. */
export interface SessionListener {
  welcome?(selfId: string, iceServers: IceServer[], identityChanged: boolean): void;
  peerJoined?(peer: PeerInfo): void;
  peerLeft?(id: string): void;
  peerMedia?(id: string, cam: boolean, mic: boolean): void;
  signal?(from: string, payload: SignalPayload): void;
}

export interface Session {
  peers: Map<string, RemotePeer>;
  iceServers(): IceServer[];
  sendSignal(to: string, payload: SignalPayload): void;
  setMedia(cam: boolean, mic: boolean): void;
  setHeld(item: HeldItem | null): void;
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
  /** Avatar picture (validated JPEG data URL) shown to others while the camera is off. */
  avatar?: string | null;
  /** Mutated in place by spawn and corrections; read by the state sender. */
  player: PlayerState;
  now: () => number;
  WebSocketImpl?: typeof WebSocket;
  listener?: SessionListener;
}

export function createSession(opts: SessionOptions): Session {
  const { player, now } = opts;
  const peers = new Map<string, RemotePeer>();
  let selfId: string | null = null;
  let color: string | null = null;
  let resumeToken: string | undefined;
  let status: ConnStatus = 'connecting';
  let error: ErrorCode | null = null;
  let seq = 0;
  let iceServers: IceServer[] = [];
  let media: { cam: boolean; mic: boolean } | null = null;
  /** undefined until setHeld: null is a real choice that must reach a resumed slot. */
  let held: HeldItem | null | undefined;
  const listener = opts.listener ?? {};
  const lastSent = { x: Number.NaN, y: Number.NaN, angle: Number.NaN, at: 0 };

  const addPeer = (info: PeerInfo) => {
    const buffer = new SnapshotBuffer();
    buffer.push({ t: now(), x: info.x, y: info.y, angle: info.angle });
    peers.set(info.id, { info: { ...info }, buffer, lastSeq: -1 });
  };

  const handle = (m: ServerMessage) => {
    switch (m.type) {
      case 'welcome': {
        // A new identity means a fresh slot (first join, expired grace, server restart): take its spawn.
        const identityChanged = m.selfId !== selfId;
        if (identityChanged) {
          Object.assign(player, m.spawn);
        }
        selfId = m.selfId;
        color = m.color;
        resumeToken = m.resumeToken;
        iceServers = m.iceServers;
        peers.clear();
        for (const p of m.peers) {
          addPeer(p);
        }
        Object.assign(lastSent, { x: player.x, y: player.y, angle: player.angle, at: now() });
        // The server forgets media state on a fresh identity; resending on resume is harmless.
        if (media) {
          conn.send({ type: 'media', ...media });
        }
        if (held !== undefined) {
          conn.send({ type: 'held', item: held });
        }
        listener.welcome?.(m.selfId, m.iceServers, identityChanged);
        break;
      }
      case 'peer_joined':
        addPeer(m.peer);
        listener.peerJoined?.(m.peer);
        break;
      case 'peer_left':
        peers.delete(m.id);
        listener.peerLeft?.(m.id);
        break;
      case 'peer_media': {
        const peer = peers.get(m.id);
        if (!peer) {
          return;
        }
        peer.info.cam = m.cam;
        peer.info.mic = m.mic;
        listener.peerMedia?.(m.id, m.cam, m.mic);
        break;
      }
      case 'peer_held': {
        const peer = peers.get(m.id);
        if (peer) {
          peer.info.held = m.item;
        }
        break;
      }
      case 'signal':
        listener.signal?.(m.from, m.payload);
        break;
      case 'peer_state': {
        const peer = peers.get(m.id);
        if (!peer || m.seq <= peer.lastSeq) {
          return;
        }
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
      ...(opts.avatar ? { avatar: opts.avatar } : {}),
    }),
    onMessage: handle,
    onStatus: (s) => {
      status = s;
    },
    WebSocketImpl: opts.WebSocketImpl,
  });

  // A timer (not rAF) so position heartbeats continue while the tab is hidden.
  const sender = setInterval(() => {
    if (status !== 'open') {
      return;
    }
    const t = now();
    const moved =
      Math.abs(player.x - lastSent.x) > MOVE_EPSILON ||
      Math.abs(player.y - lastSent.y) > MOVE_EPSILON ||
      Math.abs(player.angle - lastSent.angle) > TURN_EPSILON;
    if (!moved && t - lastSent.at < IDLE_INTERVAL_MS) {
      return;
    }
    seq++;
    conn.send({ type: 'state', x: player.x, y: player.y, angle: player.angle, seq });
    Object.assign(lastSent, { x: player.x, y: player.y, angle: player.angle, at: t });
  }, STATE_INTERVAL_MS);

  return {
    peers,
    iceServers: () => iceServers,
    sendSignal(to, payload) {
      conn.send({ type: 'signal', to, payload });
    },
    setMedia(cam, mic) {
      media = { cam, mic };
      if (status === 'open') {
        conn.send({ type: 'media', cam, mic });
      }
    },
    setHeld(item) {
      held = item;
      if (status === 'open') {
        conn.send({ type: 'held', item });
      }
    },
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
