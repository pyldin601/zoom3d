// Multiplayer session: remote peers and world objects with interpolation buffers, corrections, and timer-driven state
// sync.
import {
  CHEERS_MS,
  type ClientMessage,
  type ErrorCode,
  type GameMap,
  type HeldItem,
  IDLE_INTERVAL_MS,
  isPlausibleMove,
  JUMP_TILES,
  type LiveKitAccess,
  type ObjectEvent,
  type ObjectInfo,
  type ObjectStateMessage,
  type PeerInfo,
  type PlayerState,
  type Point,
  type Portals,
  PROTOCOL_VERSION,
  type SequenceKind,
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
  /** A peer's hand changed (not called for what a welcome or a join lists). */
  peerHeld?(id: string, before: HeldItem | null, after: HeldItem | null): void;
  /** Something an object did (a bump, a lost beep, a kick), after its pose was applied; `by` is a ball's kicker. */
  objectEvent?(id: string, event: ObjectEvent, by?: string): void;
  /** Every applied (not stale) object state, for the ball's prediction. */
  objectState?(m: ObjectStateMessage): void;
  /** The room's objects as a welcome lists them, after the session has taken them. */
  objectsReset?(objects: readonly ObjectInfo[]): void;
  /** The room's portals were flipped (by anyone, the local player included); not called for a welcome's flag. */
  portalsChanged?(on: boolean): void;
  /** A new connection status. Timer and socket driven, so it keeps coming while the tab is hidden. */
  status?(status: ConnStatus): void;
}

export interface Session {
  peers: Map<string, RemotePeer>;
  objects: Map<string, RemoteObject>;
  /** Whether the room's portals are on: from the welcome, then from each flip. */
  portals: boolean;
  /** The room's running portal switch, its start on the local clock; null when none runs (or since the last welcome). */
  sequence: { kind: SequenceKind; startedAt: number } | null;
  setMedia(cam: boolean, mic: boolean): void;
  setHeld(item: HeldItem | null): void;
  /** Shows or hides our boombox to the others; resent after every welcome. */
  setBoombox(on: boolean): void;
  /** Takes a sip of the held drink; not resent after a reconnect. */
  sendDrink(): void;
  /** Raises the held drink in a cheers; not resent after a reconnect. */
  sendCheers(): void;
  /** Kicks the ball the way `angle` faces; `k` is the local kick counter the server echoes back. */
  sendKick(angle: number, k: number): void;
  /** Asks the server to flip the room's portals; it answers everyone, this client included. */
  sendPortals(): void;
  selfId(): string | null;
  selfColor(): string | null;
  /** The name the others are told. */
  selfName(): string;
  /** Whether the others are told the own mic is on. */
  selfMic(): boolean;
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
  /** The map, to tell a walk from a portal jump in what arrives; without it nothing is marked a jump. */
  map?: GameMap;
  /** The room's portal wiring while they are on, to tell near peers from far ones as the server does. */
  portals?: () => Portals | null;
  now: () => number;
  WebSocketImpl?: typeof WebSocket;
  listener?: SessionListener;
}

/** The pose last sent, and when; null when nothing has been sent since the last welcome. */
type SentPose = { x: number; y: number; angle: number; at: number };

export function createSession(opts: SessionOptions): Session {
  const { player, now } = opts;
  const peers = new Map<string, RemotePeer>();
  /** The same peers by slot, the name `peers` batches use. */
  const bySlot = new Map<number, RemotePeer>();
  const objects = new Map<string, RemoteObject>();
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
  let portals = false;
  let sequence: Session['sequence'] = null;
  let lastSent: SentPose | null = null;
  const listener = opts.listener ?? {};

  const gesturePlaying = (g: RemotePeer['gesture']) =>
    g !== null && now() - g.at < (g.kind === 'sip' ? SIP_MS : CHEERS_MS);

  const addPeer = (info: PeerInfo) => {
    const buffer = new SnapshotBuffer();
    buffer.push({ t: now(), x: info.x, y: info.y, angle: info.angle });
    const peer: RemotePeer = { info: { ...info }, buffer, delay: new PeerDelay(), gesture: null };
    peers.set(info.id, peer);
    bySlot.set(info.slot, peer);
  };

  const removePeer = (id: string) => {
    const peer = peers.get(id);
    if (peer) {
      bySlot.delete(peer.info.slot);
    }
    peers.delete(id);
  };

  const addObject = (info: ObjectInfo) => {
    const buffer = new SnapshotBuffer();
    buffer.push({ t: now(), x: info.x, y: info.y, angle: info.angle });
    objects.set(info.id, { info: { ...info }, buffer, lastSeq: -1 });
  };

  const sendWhileOpen = (message: ClientMessage) => {
    if (status === 'open') {
      conn.send(message);
    }
  };

  // Server messages.

  const handle = (m: ServerMessage) => {
    switch (m.type) {
      case 'welcome':
        applyWelcome(m);
        break;
      case 'peer_joined':
        addPeer(m.peer);
        listener.peerJoined?.(m.peer);
        break;
      case 'peer_left':
        removePeer(m.id);
        listener.peerLeft?.(m.id);
        break;
      case 'peer_media':
        applyPeerMedia(m.id, m.cam, m.mic);
        break;
      case 'peer_drink':
        startGesture(m.id, 'sip');
        break;
      case 'peer_cheers':
        startGesture(m.id, 'cheers');
        break;
      case 'peer_boombox':
        applyPeerBoombox(m.id, m.on);
        break;
      case 'peer_held':
        applyPeerHeld(m.id, m.item);
        break;
      case 'peers':
        applyPeerPoses(m.s);
        break;
      case 'object_state':
        applyObjectState(m);
        break;
      case 'portals':
        portals = m.on;
        listener.portalsChanged?.(m.on);
        break;
      case 'portals_sequence':
        sequence = { kind: m.kind, startedAt: now() - m.age };
        break;
      case 'correction':
        Object.assign(player, { x: m.x, y: m.y, angle: m.angle });
        break;
      case 'error':
        error = m.code;
        break;
    }
  };

  const applyWelcome = (m: Extract<ServerMessage, { type: 'welcome' }>) => {
    // A new identity means a fresh slot (first join, expired grace, server restart): take its spawn.
    const identityChanged = m.selfId !== selfId;
    if (identityChanged) {
      Object.assign(player, m.spawn);
    }
    selfId = m.selfId;
    color = m.color;
    resumeToken = m.resumeToken;
    portals = m.portals;
    // No clock syncing: the start is the arrival less the server's age, so the link's one-way delay shifts it late.
    sequence = m.sequence ? { kind: m.sequence.kind, startedAt: now() - m.sequence.age } : null;
    peers.clear();
    bySlot.clear();
    for (const p of m.peers) {
      addPeer(p);
    }
    // A restarted server counts each object's seq from 1 again: start every object afresh.
    objects.clear();
    for (const o of m.objects) {
      addObject(o);
    }
    listener.objectsReset?.(m.objects);
    // The local pose goes out on the next tick: after a resume the server only has the one from before the outage
    // (moves sent into a dying socket were lost), and a fresh spawn costs one message.
    lastSent = null;
    resendOwnState();
    listener.welcome?.(m.selfId, m.livekit, identityChanged);
  };

  /** The server forgets these on a fresh identity; resending them on a resume is harmless. */
  const resendOwnState = () => {
    if (media) {
      conn.send({ type: 'media', ...media });
    }
    if (held !== undefined) {
      conn.send({ type: 'held', item: held });
    }
    if (boombox !== undefined) {
      conn.send({ type: 'boombox', on: boombox });
    }
  };

  const applyPeerMedia = (id: string, cam: boolean, mic: boolean) => {
    const peer = peers.get(id);
    if (!peer) {
      return;
    }
    peer.info.cam = cam;
    peer.info.mic = mic;
    listener.peerMedia?.(id, cam, mic);
  };

  const startGesture = (id: string, kind: 'sip' | 'cheers') => {
    const peer = peers.get(id);
    // A gesture arriving while one still plays (bunched by the network) would snap it back to the start.
    if (peer && !gesturePlaying(peer.gesture)) {
      peer.gesture = { kind, at: now() };
    }
  };

  const applyPeerBoombox = (id: string, on: boolean) => {
    const peer = peers.get(id);
    if (peer) {
      peer.info.boombox = on;
    }
  };

  const applyPeerHeld = (id: string, item: HeldItem | null) => {
    const peer = peers.get(id);
    if (!peer) {
      return;
    }
    const before = peer.info.held;
    peer.info.held = item;
    if (item === null) {
      peer.gesture = null;
    }
    if (before !== item) {
      listener.peerHeld?.(id, before, item);
    }
  };

  /** The socket is ordered, so a batch is always newer than the last: it carries no seq. */
  const applyPeerPoses = (entries: Extract<ServerMessage, { type: 'peers' }>['s']) => {
    const arrival = now();
    for (const [slot, x, y, angle, age] of entries) {
      const peer = bySlot.get(slot);
      if (!peer) {
        continue;
      }
      // Each pose goes where the server accepted it, not where its tick sent it (a faster batch than the last could
      // put it earlier than the previous pose: then it goes just after).
      const latest = peer.buffer.latest();
      const t = latest ? Math.max(arrival - age, latest.t + 1) : arrival - age;
      const jump = latest !== null && peerJumped(latest, x, y, t - latest.t);
      holdBefore(peer.buffer, t, tierInterval(nearTier(opts.portals?.() ?? null, player, x, y)));
      peer.info.x = x;
      peer.info.y = y;
      peer.info.angle = angle;
      peer.buffer.push(jump ? { t, x, y, angle, jump } : { t, x, y, angle });
    }
  };

  /** A pose no walk explains: the peer went through a portal. Judged against the last real pose, not a hold. */
  const peerJumped = (from: Point, x: number, y: number, elapsedMs: number) =>
    opts.map !== undefined && !isPlausibleMove(opts.map, from, { x, y }, elapsedMs);

  const applyObjectState = (m: Extract<ServerMessage, { type: 'object_state' }>) => {
    const obj = objects.get(m.id);
    if (!obj || m.seq <= obj.lastSeq) {
      return;
    }
    obj.lastSeq = m.seq;
    const jump = Math.hypot(m.x - obj.info.x, m.y - obj.info.y) > JUMP_TILES;
    Object.assign(obj.info, { x: m.x, y: m.y, angle: m.angle });
    obj.buffer.push(
      jump ? { t: now(), x: m.x, y: m.y, angle: m.angle, jump } : { t: now(), x: m.x, y: m.y, angle: m.angle }
    );
    listener.objectState?.(m);
    if (m.event) {
      listener.objectEvent?.(m.id, m.event, m.by);
    }
  };

  // The connection.

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

  // Our pose.

  const movedSince = (sent: SentPose) =>
    Math.abs(player.x - sent.x) > MOVE_EPSILON ||
    Math.abs(player.y - sent.y) > MOVE_EPSILON ||
    Math.abs(player.angle - sent.angle) > TURN_EPSILON;

  /** When we moved, or as an idle heartbeat. */
  const sendPoseIfDue = () => {
    if (status !== 'open') {
      return;
    }
    const t = now();
    if (lastSent && !movedSince(lastSent) && t - lastSent.at < IDLE_INTERVAL_MS) {
      return;
    }
    seq++;
    conn.send({ type: 'state', x: player.x, y: player.y, angle: player.angle, seq });
    lastSent ??= { x: 0, y: 0, angle: 0, at: 0 };
    Object.assign(lastSent, { x: player.x, y: player.y, angle: player.angle, at: t });
  };
  // A timer (not rAF) so position heartbeats continue while the tab is hidden.
  const sender = setInterval(sendPoseIfDue, STATE_INTERVAL_MS);

  return {
    peers,
    objects,
    get portals() {
      return portals;
    },
    get sequence() {
      return sequence;
    },
    setMedia(cam, mic) {
      media = { cam, mic };
      sendWhileOpen({ type: 'media', cam, mic });
    },
    setHeld(item) {
      held = item;
      sendWhileOpen({ type: 'held', item });
    },
    setBoombox(on) {
      boombox = on;
      sendWhileOpen({ type: 'boombox', on });
    },
    sendDrink: () => sendWhileOpen({ type: 'drink' }),
    sendCheers: () => sendWhileOpen({ type: 'cheers' }),
    sendKick: (angle, k) => sendWhileOpen({ type: 'kick', angle, k }),
    sendPortals: () => sendWhileOpen({ type: 'portals' }),
    selfId: () => selfId,
    selfColor: () => color,
    selfName: () => opts.name,
    selfMic: () => media?.mic ?? false,
    status: () => status,
    error: () => error,
    close() {
      clearInterval(sender);
      conn.close();
    },
  };
}
