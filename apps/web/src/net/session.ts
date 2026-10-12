// Multiplayer session: remote peers and world objects with interpolation buffers, corrections, and timer-driven state
// sync.
import {
  CHEERS_MS,
  type ErrorCode,
  type HeldItem,
  IDLE_INTERVAL_MS,
  type LiveKitAccess,
  type ObjectEvent,
  type ObjectInfo,
  type PeerInfo,
  type PlayerState,
  PROTOCOL_VERSION,
  type ServerMessage,
  SIP_MS,
  SnapshotBuffer,
  STATE_INTERVAL_MS,
} from '@zoom3d/shared';
import { type ConnStatus, connect } from './connection';
import { holdBefore, nearTier, PeerDelay, tierInterval } from './peer-delay';

const MOVE_EPSILON = 1e-4;
const TURN_EPSILON = 1e-3;

export interface RemotePeer {
  info: PeerInfo;
  buffer: SnapshotBuffer;
  /** How far in the past to draw this peer: depends on how often the server sends it (6d spec §2.3). */
  delay: PeerDelay;
  /** This peer's last sip or cheers, by when it arrived (now()); null before any or once the drink is put down. */
  gesture: { kind: 'sip' | 'cheers'; at: number } | null;
}

/** A server-driven world object, like the robot vacuum (robot vacuum spec §4). Not a peer. */
export interface RemoteObject {
  info: ObjectInfo;
  buffer: SnapshotBuffer;
  lastSeq: number;
}

/** Key of an object in shared position and audio maps, never colliding with a peer id. */
export const objectKey = (id: string) => `object:${id}`;

/** Notified after the session has applied each server event to its own state. */
export interface SessionListener {
  welcome?(selfId: string, livekit: LiveKitAccess, identityChanged: boolean): void;
  peerJoined?(peer: PeerInfo): void;
  peerLeft?(id: string): void;
  peerMedia?(id: string, cam: boolean, mic: boolean): void;
  /** Something an object did (a bump, a lost beep), after its pose was applied. */
  objectEvent?(id: string, event: ObjectEvent): void;
  /** A new connection status. Timer and socket driven, so it keeps coming while the tab is hidden. */
  status?(status: ConnStatus): void;
}

export interface Session {
  peers: Map<string, RemotePeer>;
  objects: Map<string, RemoteObject>;
  setMedia(cam: boolean, mic: boolean): void;
  setHeld(item: HeldItem | null): void;
  /** Shows or hides our boombox to the others; resent after every welcome. */
  setBoombox(on: boolean): void;
  /** Takes a sip of the held drink; not resent after a reconnect. */
  sendDrink(): void;
  /** Raises the held drink in a cheers; not resent after a reconnect. */
  sendCheers(): void;
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
  /** Wandering bots to ask for if this join creates the room (`?bots=N`). */
  bots?: number | null;
  /** Mutated in place by spawn and corrections; read by the state sender. */
  player: PlayerState;
  now: () => number;
  WebSocketImpl?: typeof WebSocket;
  listener?: SessionListener;
}

export function createSession(opts: SessionOptions): Session {
  const { player, now } = opts;
  const peers = new Map<string, RemotePeer>();
  /** The same peers by slot, the name `peers` batches use. */
  const bySlot = new Map<number, RemotePeer>();
  const objects = new Map<string, RemoteObject>();
  const playing = (g: RemotePeer['gesture']) => g !== null && now() - g.at < (g.kind === 'sip' ? SIP_MS : CHEERS_MS);
  let selfId: string | null = null;
  let color: string | null = null;
  let resumeToken: string | undefined;
  let status: ConnStatus = 'connecting';
  let error: ErrorCode | null = null;
  let seq = 0;
  let media: { cam: boolean; mic: boolean } | null = null;
  /** undefined until setHeld: null is a real choice that must reach a resumed slot. */
  let held: HeldItem | null | undefined;
  /** undefined until setBoombox: false must reach a resumed slot that may still say true. */
  let boombox: boolean | undefined;
  const listener = opts.listener ?? {};
  const lastSent = { x: Number.NaN, y: Number.NaN, angle: Number.NaN, at: 0 };

  const addPeer = (info: PeerInfo) => {
    const buffer = new SnapshotBuffer();
    buffer.push({ t: now(), x: info.x, y: info.y, angle: info.angle });
    const peer: RemotePeer = { info: { ...info }, buffer, delay: new PeerDelay(), gesture: null };
    peers.set(info.id, peer);
    bySlot.set(info.slot, peer);
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
        peers.clear();
        bySlot.clear();
        for (const p of m.peers) {
          addPeer(p);
        }
        // A restarted server counts each object's seq from 1 again: start every object afresh.
        objects.clear();
        for (const o of m.objects) {
          const buffer = new SnapshotBuffer();
          buffer.push({ t: now(), x: o.x, y: o.y, angle: o.angle });
          objects.set(o.id, { info: { ...o }, buffer, lastSeq: -1 });
        }
        Object.assign(lastSent, { x: player.x, y: player.y, angle: player.angle, at: now() });
        // The server forgets media state on a fresh identity; resending on resume is harmless.
        if (media) {
          conn.send({ type: 'media', ...media });
        }
        if (held !== undefined) {
          conn.send({ type: 'held', item: held });
        }
        if (boombox !== undefined) {
          conn.send({ type: 'boombox', on: boombox });
        }
        listener.welcome?.(m.selfId, m.livekit, identityChanged);
        break;
      }
      case 'peer_joined':
        addPeer(m.peer);
        listener.peerJoined?.(m.peer);
        break;
      case 'peer_left': {
        const peer = peers.get(m.id);
        if (peer) {
          bySlot.delete(peer.info.slot);
        }
        peers.delete(m.id);
        listener.peerLeft?.(m.id);
        break;
      }
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
      case 'peer_drink':
      case 'peer_cheers': {
        const peer = peers.get(m.id);
        // A gesture arriving while one still plays (bunched by the network) would snap it back to the start.
        if (peer && !playing(peer.gesture)) {
          peer.gesture = { kind: m.type === 'peer_drink' ? 'sip' : 'cheers', at: now() };
        }
        break;
      }
      case 'peer_boombox': {
        const peer = peers.get(m.id);
        if (peer) {
          peer.info.boombox = m.on;
        }
        break;
      }
      case 'peer_held': {
        const peer = peers.get(m.id);
        if (peer) {
          peer.info.held = m.item;
          if (m.item === null) {
            peer.gesture = null;
          }
        }
        break;
      }
      case 'peers': {
        // The socket is ordered, so there is no seq: a batch is always newer than the last.
        const t = now();
        for (const [slot, x, y, angle] of m.s) {
          const peer = bySlot.get(slot);
          if (!peer) {
            continue;
          }
          holdBefore(peer.buffer, t, tierInterval(nearTier(player.x, player.y, x, y)));
          peer.info.x = x;
          peer.info.y = y;
          peer.info.angle = angle;
          peer.buffer.push({ t, x, y, angle });
        }
        break;
      }
      case 'object_state': {
        const obj = objects.get(m.id);
        if (!obj || m.seq <= obj.lastSeq) {
          return;
        }
        obj.lastSeq = m.seq;
        Object.assign(obj.info, { x: m.x, y: m.y, angle: m.angle });
        obj.buffer.push({ t: now(), x: m.x, y: m.y, angle: m.angle });
        if (m.event) {
          listener.objectEvent?.(m.id, m.event);
        }
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

  let notified: ConnStatus = status;
  const notifyStatus = () => {
    if (status !== notified) {
      notified = status;
      opts.listener?.status?.(status);
    }
  };

  const conn = connect({
    url: opts.url,
    makeJoin: () => ({
      type: 'join',
      v: PROTOCOL_VERSION,
      roomId: opts.roomId,
      name: opts.name,
      ...(resumeToken ? { resumeToken } : {}),
      ...(opts.avatar ? { avatar: opts.avatar } : {}),
      ...(opts.bots ? { bots: opts.bots } : {}),
    }),
    // 'open' and 'failed' arrive with the welcome or error that caused them: tell the listener once that is applied.
    onMessage: (msg) => {
      handle(msg);
      notifyStatus();
    },
    onStatus: (s) => {
      status = s;
      if (s === 'reconnecting') {
        notifyStatus();
      }
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
    objects,
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
    setBoombox(on) {
      boombox = on;
      if (status === 'open') {
        conn.send({ type: 'boombox', on });
      }
    },
    sendDrink() {
      if (status === 'open') {
        conn.send({ type: 'drink' });
      }
    },
    sendCheers() {
      if (status === 'open') {
        conn.send({ type: 'cheers' });
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
