// Room membership, colours, resume grace and move validation, plus opt-in wandering bots and each room's robot vacuum
// and ball.
// Pure: no sockets or timers (the server drives tick(), fanOut() and stepWorld()).
//
// A room is a map of peers by id: people (with a connection, or within their resume grace without one) and bots. A
// room opens with its first person and closes with its last; bots and the world objects never keep it open.
import {
  type Apparent,
  apparentPosition,
  BALL_KICK_GAP_MS,
  type Ball,
  type BallBody,
  type BallSave,
  type BoomboxMessage,
  ballInfo,
  ballMoving,
  createBall,
  createVacuum,
  createVacuumNav,
  DRINK_GAP_MS,
  type GameMap,
  type HeldMessage,
  isPlausibleMove,
  isValidAvatar,
  isValidRoomId,
  type JoinMessage,
  type KickMessage,
  kickBall,
  type LiveKitAccess,
  MAX_PEERS,
  type MediaMessage,
  type PeerInfo,
  PLAYER_RADIUS,
  type Point,
  type Portals,
  PROTOCOL_VERSION,
  RESUME_GRACE_MS,
  restoreBall,
  restoreVacuum,
  type ServerMessage,
  type StateMessage,
  sanitizeName,
  saveBall,
  saveVacuum,
  spawnPoint,
  stepBall,
  stepVacuum,
  VACUUM_RADIUS,
  VACUUM_SPEED,
  type Vacuum,
  type VacuumNav,
  type VacuumSave,
  vacuumInfo,
  wirePortals,
} from '@zoom3d/shared';
import { AvatarStore } from './avatars';
import { floorTiles, MAX_BOT_ROOMS, placeBot, stepBot } from './bots';
import { pickColor } from './colors';
import { type SentLog, selectBatch } from './fanout';

/** WebSocket close codes. */
const CLOSE_ROOM_FULL = 4001;
const CLOSE_INVALID = 4002;
const CLOSE_REPLACED = 4003;

/** At most one portals flip per room in this time, and the move check honours the old mode for as long after it. */
const PORTALS_FLIP_GAP_MS = 1000;

export interface Outbox {
  send(connId: string, msg: ServerMessage): void;
  /** One message to many connections, so the transport can encode it once. */
  broadcast(connIds: readonly string[], msg: ServerMessage): void;
  close(connId: string, code: number, reason: string): void;
}

type RejectReason = 'room_full' | 'invalid_room' | 'invalid_name' | 'outdated';
const OUTDATED = 'zoom3d was updated: reload the page';

/** What happened in the lobby, for logs and metrics. Carries ids only: never names or tokens. */
export type LobbyEvent =
  | { type: 'room_opened' | 'room_closed'; roomId: string }
  | { type: 'joined'; roomId: string; peerId: string; resumed: boolean; replaced: boolean; peers: number }
  | { type: 'rejected'; reason: RejectReason }
  | { type: 'disconnected' | 'move_corrected'; roomId: string; peerId: string }
  | { type: 'left'; roomId: string; peerId: string; peers: number }
  | { type: 'bots_spawned'; roomId: string; count: number };

export interface LobbyStats {
  rooms: number;
  /** Peers with a live connection. */
  connected: number;
  /** Peers in their resume grace period. */
  waiting: number;
  /** Server-driven bots (never counted as people). */
  bots: number;
}

export interface LobbyOptions {
  map: GameMap;
  out: Outbox;
  now: () => number;
  rng: () => number;
  /** Creates peer ids and resume tokens. */
  newToken: () => string;
  graceMs?: number;
  /** LiveKit URL and a token for `peerId` in room `roomId` (LiveKit spec §3); minted on every welcome. */
  liveKitFor: (roomId: string, peerId: string) => LiveKitAccess;
  onEvent?: (e: LobbyEvent) => void;
  /** Every new room gets a robot vacuum (robot vacuum spec §3.1). Off unless set, so tests opt in. */
  vacuum?: boolean;
  /** Dev only: new vacuums start with every patch but their own clean, to reach the dock search in a minute. */
  vacuumNearlyDone?: boolean;
  /** Every new room gets a ball (ball spec §3.2). Off unless set, so tests opt in. */
  ball?: boolean;
}

/** The server sees a kicker a little late, so it allows them this much further away than the client does. */
const KICK_SLACK = 0.5;
const seen: Apparent = { x: 0, y: 0, sees: false, through: 0 };

/** A walker whose last pose is older than this is standing still, as far as the ball can tell. */
const MOVING_POSE_MS = 200;

interface Peer extends PeerInfo {
  resumeToken: string;
  conn: string | null;
  lastAcceptedAt: number;
  /** When this peer's last sip or cheers was relayed (not shared: gestures are never stored). */
  lastGestureAt: number;
  disconnectedAt: number | null;
  /** The picture itself (a JPEG data URL) behind `avatar`, its id in the avatar store. */
  picture: string | null;
  /** Tiles/s, from the last two poses: how hard walking into the ball pushes it. */
  vx: number;
  vy: number;
  /** When this person last kicked the ball. */
  lastKickAt: number;
  /** Bumped whenever the pose changes, so fan-out sends only what moved. */
  poseVersion: number;
  /** When the pose last changed: batches carry its age, so receivers can place it on its real timeline. */
  poseAt: number;
  /** What this peer, as a recipient, was last sent of each other peer (6d spec §2.1). */
  sent: SentLog;
  /** Set on a wandering bot: no connection, never expires, never resumable, never saved. */
  bot?: true;
}

type Room = Map<string, Peer>;

/**
 * A peer as written to the restart snapshot: no connection, gesture timing or slot (restore hands out new ones), and
 * `avatar` is the picture's data URL, not its id.
 */
export interface SnapshotPeer extends Omit<PeerInfo, 'slot'> {
  resumeToken: string;
  lastAcceptedAt: number;
}

/** Bump `version` when SnapshotPeer changes in a way parsePeerInfo's defaults can't absorb. */
export interface LobbySnapshot {
  version: 1;
  rooms: { id: string; peers: SnapshotPeer[]; vacuum?: VacuumSave; ball?: BallSave; portals?: boolean }[];
}

const isPerson = (p: Peer) => p.bot === undefined;

/** The room's people, without its bots. */
const peopleIn = (room: Room) => [...room.values()].filter(isPerson);

function countPeople(room: Room): number {
  let count = 0;
  for (const p of room.values()) {
    if (isPerson(p)) {
      count++;
    }
  }
  return count;
}

function hasConnection(room: Room): boolean {
  for (const p of room.values()) {
    if (p.conn !== null) {
      return true;
    }
  }
  return false;
}

/** The peer as everyone else sees it on the wire. */
const peerInfo = ({ id, slot, name, color, x, y, angle, cam, mic, avatar, held, boombox }: Peer): PeerInfo => ({
  id,
  slot,
  name,
  color,
  x,
  y,
  angle,
  cam,
  mic,
  avatar,
  held,
  boombox,
});

/** A person as saved: the picture itself, as before 6d, since avatar ids mean nothing to the next process. */
function savePeer(p: Peer): SnapshotPeer {
  const { slot: _, ...saved } = peerInfo(p);
  return { ...saved, avatar: p.picture, resumeToken: p.resumeToken, lastAcceptedAt: p.lastAcceptedAt };
}

/** The bookkeeping every new or restored peer starts with: no gesture yet, a fresh pose, nothing sent. */
function freshTracking(
  now: number
): Pick<Peer, 'lastGestureAt' | 'lastKickAt' | 'vx' | 'vy' | 'poseVersion' | 'poseAt' | 'sent'> {
  return {
    lastGestureAt: Number.NEGATIVE_INFINITY,
    lastKickAt: Number.NEGATIVE_INFINITY,
    vx: 0,
    vy: 0,
    poseVersion: 0,
    poseAt: now,
    sent: new Map(),
  };
}

export class Lobby {
  private readonly rooms = new Map<string, Room>();
  private readonly conns = new Map<string, { roomId: string; peerId: string }>();
  private readonly graceMs: number;
  /** Floor tiles for spawning bots, found on first use. */
  private floor: { x: number; y: number }[] | null = null;
  private nav: VacuumNav | null = null;
  /** Each room's robot vacuum, by room id. Not a peer: it never keeps a room open. */
  private readonly vacuums = new Map<string, Vacuum>();
  /** Each vacuum's velocity over its last step, by room id: how hard it knocks the ball. */
  private readonly vacuumVelocities = new Map<string, { vx: number; vy: number }>();
  /** Each room's ball, by room id. Not a peer either. */
  private readonly balls = new Map<string, Ball>();
  /** A person's kick since the ball's last broadcast, echoed in it so the kicker recognises its own kick. */
  private readonly kicks = new Map<string, { by: string; k: number }>();
  /** Each room's portals flag and when it last flipped; a room with no entry has them off and never flipped. */
  private readonly portalModes = new Map<string, { on: boolean; flippedAt: number }>();
  /** Each room's doorway wiring, built the first time the room needs it. */
  private readonly wirings = new Map<string, Portals>();
  /** Each room's next peer slot: a counter, so a late batch can never move the wrong peer. */
  private readonly nextSlot = new Map<string, number>();
  private readonly avatars = new AvatarStore();

  constructor(private readonly opts: LobbyOptions) {
    this.graceMs = opts.graceMs ?? RESUME_GRACE_MS;
  }

  // Queries.

  roomCount(): number {
    return this.rooms.size;
  }

  peerCount(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  stats(): LobbyStats {
    let connected = 0;
    let waiting = 0;
    let bots = 0;
    for (const room of this.rooms.values()) {
      for (const p of room.values()) {
        if (p.bot) {
          bots++;
        } else if (p.conn === null) {
          waiting++;
        } else {
          connected++;
        }
      }
    }
    return { rooms: this.rooms.size, connected, waiting, bots };
  }

  /** The JPEG served at `GET /avatar/<id>`, while someone in any room uses it. */
  avatar(id: string): Buffer | null {
    return this.avatars.get(id);
  }

  // Messages from a connection.

  /** Takes a person back into their place if they bring its resume token, else admits them as someone new. */
  join(conn: string, msg: JoinMessage): void {
    if (this.conns.has(conn)) {
      return;
    }
    const name = this.acceptedName(conn, msg);
    if (name === null) {
      return;
    }
    const room = this.rooms.get(msg.roomId) ?? new Map<string, Peer>();
    const resumable =
      msg.resumeToken === undefined ? undefined : peopleIn(room).find((p) => p.resumeToken === msg.resumeToken);
    if (resumable) {
      this.resume(conn, msg.roomId, room, resumable);
      return;
    }
    if (countPeople(room) >= MAX_PEERS) {
      this.reject(conn, 'room_full', 'This room is full', CLOSE_ROOM_FULL);
      return;
    }
    this.admit(conn, msg, room, name);
  }

  state(conn: string, msg: StateMessage): void {
    const found = this.peerOf(conn);
    if (!found) {
      return;
    }
    const { roomId, peer } = found;
    const now = this.opts.now();
    if (!this.isPlausibleInRoom(roomId, peer, msg, now)) {
      this.opts.out.send(conn, { type: 'correction', x: peer.x, y: peer.y, angle: peer.angle, seq: msg.seq });
      this.emit({ type: 'move_corrected', roomId, peerId: peer.id });
      return;
    }
    // An idle heartbeat repeats the pose: it keeps the move check's clock, but there is nothing to send.
    if (msg.x !== peer.x || msg.y !== peer.y || msg.angle !== peer.angle) {
      const sincePose = now - peer.poseAt;
      const moving = sincePose > 0 && sincePose <= MOVING_POSE_MS;
      peer.vx = moving ? ((msg.x - peer.x) * 1000) / sincePose : 0;
      peer.vy = moving ? ((msg.y - peer.y) * 1000) / sincePose : 0;
      peer.x = msg.x;
      peer.y = msg.y;
      peer.angle = msg.angle;
      peer.poseVersion++;
      peer.poseAt = now;
    }
    peer.lastAcceptedAt = now;
  }

  /** Flips the room's portals for everyone, unless it flipped less than a second ago. */
  portals(conn: string): void {
    const found = this.peerOf(conn);
    if (!found) {
      return;
    }
    const { roomId, room } = found;
    const now = this.opts.now();
    const mode = this.portalMode(roomId);
    if (now - mode.flippedAt < PORTALS_FLIP_GAP_MS) {
      return;
    }
    mode.on = !mode.on;
    mode.flippedAt = now;
    this.broadcast(room, '', { type: 'portals', on: mode.on });
  }

  media(conn: string, msg: MediaMessage): void {
    const found = this.peerOf(conn);
    if (!found) {
      return;
    }
    const { room, peer } = found;
    peer.cam = msg.cam;
    peer.mic = msg.mic;
    this.broadcast(room, peer.id, { type: 'peer_media', id: peer.id, cam: msg.cam, mic: msg.mic });
  }

  held(conn: string, msg: HeldMessage): void {
    const found = this.peerOf(conn);
    if (!found) {
      return;
    }
    const { room, peer } = found;
    peer.held = msg.item;
    this.broadcast(room, peer.id, { type: 'peer_held', id: peer.id, item: msg.item });
  }

  boombox(conn: string, msg: BoomboxMessage): void {
    const found = this.peerOf(conn);
    if (!found) {
      return;
    }
    const { room, peer } = found;
    peer.boombox = msg.on;
    this.broadcast(room, peer.id, { type: 'peer_boombox', id: peer.id, on: msg.on });
  }

  /** Kicks the room's ball from where the server last saw the kicker, if they're near enough and not kicking too often. */
  kick(conn: string, msg: KickMessage): void {
    const found = this.peerOf(conn);
    const ball = found && this.balls.get(found.roomId);
    const now = this.opts.now();
    if (!found || !ball || now - found.peer.lastKickAt < BALL_KICK_GAP_MS) {
      return;
    }
    const portals = this.activePortals(found.roomId);
    if (kickBall(ball, this.seenFrom(portals, ball, found.peer), msg.angle, KICK_SLACK)) {
      found.peer.lastKickAt = now;
      this.kicks.set(found.roomId, { by: found.peer.id, k: msg.k });
    }
  }

  /** Relays a sip, only from a peer holding a drink and at most one gesture per DRINK_GAP_MS. */
  drink(conn: string): void {
    this.gesture(conn, 'peer_drink');
  }

  /** Relays a cheers under the same rules as a sip, sharing its gap. */
  cheers(conn: string): void {
    this.gesture(conn, 'peer_cheers');
  }

  /** The connection is gone: its person keeps their place for the resume grace period. */
  disconnect(conn: string): void {
    const found = this.peerOf(conn);
    this.conns.delete(conn);
    if (!found) {
      return;
    }
    found.peer.conn = null;
    found.peer.disconnectedAt = this.opts.now();
    this.emit({ type: 'disconnected', roomId: found.roomId, peerId: found.peer.id });
  }

  // Timers.

  /** Expires peers whose grace has run out and closes rooms with nobody left. */
  tick(): void {
    const now = this.opts.now();
    for (const [roomId, room] of this.rooms) {
      for (const peer of [...room.values()]) {
        if (peer.disconnectedAt !== null && now - peer.disconnectedAt >= this.graceMs) {
          this.expire(roomId, room, peer);
        }
      }
      // Bots never keep a room alive: it closes with its last person.
      if (countPeople(room) === 0) {
        this.closeRoom(roomId);
      }
    }
  }

  /**
   * One server tick of state (6d spec §2.1): each connected person gets one `peers` batch of the poses that changed
   * since they were last sent to them, near ones every tick and far ones at most every FAR_INTERVAL_MS.
   */
  fanOut(): void {
    const now = this.opts.now();
    for (const [roomId, room] of this.rooms) {
      const portals = this.activePortals(roomId);
      for (const p of room.values()) {
        if (p.conn === null) {
          continue;
        }
        const s = selectBatch(p, room.values(), p.sent, now, portals);
        if (s.length > 0) {
          this.opts.out.send(p.conn, { type: 'peers', s });
        }
      }
    }
  }

  /** Moves every room's bots, robot vacuum and ball; rooms with nobody connected stand still. */
  stepWorld(dtMs: number): void {
    const dt = dtMs / 1000;
    this.stepBots(dt);
    this.stepVacuums(dt);
    this.stepBalls(dt);
  }

  // Restart survival.

  snapshot(): LobbySnapshot {
    return {
      version: 1,
      rooms: [...this.rooms].map(([id, room]) => {
        const vacuum = this.vacuums.get(id);
        const ball = this.balls.get(id);
        const portalsOn = this.portalModes.get(id)?.on === true;
        return {
          id,
          peers: peopleIn(room).map(savePeer),
          ...(vacuum ? { vacuum: saveVacuum(this.vacuumNav(), vacuum) } : {}),
          ...(ball ? { ball: saveBall(this.opts.map, ball) } : {}),
          ...(portalsOn ? { portals: true } : {}),
        };
      }),
    };
  }

  /** Loads a snapshot into an empty lobby. Every slot starts a fresh grace period, waiting for its owner to resume. */
  restore(snap: LobbySnapshot): void {
    const now = this.opts.now();
    for (const { id, peers, vacuum, ball, portals } of snap.rooms) {
      const room: Room = new Map();
      for (const saved of peers) {
        room.set(saved.id, {
          ...saved,
          ...this.picture(saved.avatar),
          slot: this.takeSlot(id),
          conn: null,
          disconnectedAt: now,
          ...freshTracking(now),
        });
      }
      this.rooms.set(id, room);
      if (portals) {
        this.portalModes.set(id, { on: true, flippedAt: Number.NEGATIVE_INFINITY });
      }
      this.emit({ type: 'room_opened', roomId: id });
      // A robot saved on another map (or none saved) starts afresh.
      const restored = this.opts.vacuum && vacuum ? restoreVacuum(this.vacuumNav(), vacuum) : null;
      if (restored) {
        this.vacuums.set(id, restored);
      } else {
        this.spawnVacuum(id);
      }
      const restoredBall = this.opts.ball && ball ? restoreBall(this.opts.map, ball, this.opts.newToken()) : null;
      if (restoredBall) {
        this.balls.set(id, restoredBall);
      } else {
        this.spawnBall(id);
      }
    }
  }

  // Joining and leaving.

  /** The join's sanitized name, or null after rejecting a join from an outdated tab, to a bad room or with a bad name. */
  private acceptedName(conn: string, msg: JoinMessage): string | null {
    // Tabs opened before 6d send no version and only know fatal invalid_room ("Couldn't join this room").
    if (msg.v === undefined) {
      this.reject(conn, 'invalid_room', OUTDATED, CLOSE_INVALID, 'outdated');
      return null;
    }
    if (msg.v < PROTOCOL_VERSION) {
      this.reject(conn, 'outdated', OUTDATED, CLOSE_INVALID);
      return null;
    }
    if (!isValidRoomId(msg.roomId)) {
      this.reject(conn, 'invalid_room', 'Invalid room link', CLOSE_INVALID);
      return null;
    }
    const name = sanitizeName(msg.name);
    if (name === null) {
      this.reject(conn, 'invalid_name', 'Invalid name', CLOSE_INVALID);
    }
    return name;
  }

  /** Hands a person's place to their new connection, closing the old one if the server hadn't noticed it die. */
  private resume(conn: string, roomId: string, room: Room, peer: Peer): void {
    const stale = peer.conn;
    if (stale !== null) {
      this.conns.delete(stale);
      this.opts.out.close(stale, CLOSE_REPLACED, 'replaced');
    }
    peer.conn = conn;
    peer.disconnectedAt = null;
    this.conns.set(conn, { roomId, peerId: peer.id });
    this.welcome(conn, roomId, room, peer);
    const replaced = stale !== null;
    this.emit({ type: 'joined', roomId, peerId: peer.id, resumed: true, replaced, peers: countPeople(room) });
  }

  /** Adds someone new to the room (opening it if they are its first person) and tells everyone else. */
  private admit(conn: string, msg: JoinMessage, room: Room, name: string): void {
    const { roomId } = msg;
    const now = this.opts.now();
    const usedColors = new Set(peopleIn(room).map((p) => p.color));
    const spawn = spawnPoint(this.opts.map, this.opts.rng);
    const peer: Peer = {
      id: this.opts.newToken(),
      slot: this.takeSlot(roomId),
      name,
      color: pickColor(usedColors),
      ...spawn,
      cam: false,
      mic: false,
      ...this.picture(isValidAvatar(msg.avatar) ? msg.avatar : null),
      held: null,
      boombox: false,
      resumeToken: this.opts.newToken(),
      conn,
      lastAcceptedAt: now,
      disconnectedAt: null,
      ...freshTracking(now),
    };
    if (room.size === 0) {
      this.openRoom(roomId, room, msg.bots);
    }
    room.set(peer.id, peer);
    this.rooms.set(roomId, room);
    this.conns.set(conn, { roomId, peerId: peer.id });
    this.welcome(conn, roomId, room, peer);
    this.broadcast(room, peer.id, { type: 'peer_joined', peer: peerInfo(peer) });
    // peer_joined carried the newcomer's pose: nobody needs it again until it moves.
    for (const p of room.values()) {
      if (p !== peer) {
        p.sent.set(peer.id, { version: peer.poseVersion, at: now });
      }
    }
    this.emit({ type: 'joined', roomId, peerId: peer.id, resumed: false, replaced: false, peers: countPeople(room) });
  }

  /** A room's first person opens it, with a robot vacuum and any bots the link asked for (while the server allows). */
  private openRoom(roomId: string, room: Room, bots: number | undefined): void {
    this.emit({ type: 'room_opened', roomId });
    if (bots && this.countBotRooms() < MAX_BOT_ROOMS) {
      this.spawnBots(roomId, room, bots);
      this.emit({ type: 'bots_spawned', roomId, count: bots });
    }
    this.spawnVacuum(roomId);
    this.spawnBall(roomId);
  }

  /** Removes a person whose grace ran out, and tells the room. */
  private expire(roomId: string, room: Room, peer: Peer): void {
    room.delete(peer.id);
    if (peer.avatar !== null) {
      this.avatars.release(peer.avatar);
    }
    for (const p of room.values()) {
      p.sent.delete(peer.id);
    }
    this.broadcast(room, peer.id, { type: 'peer_left', id: peer.id });
    this.emit({ type: 'left', roomId, peerId: peer.id, peers: countPeople(room) });
  }

  private closeRoom(roomId: string): void {
    this.rooms.delete(roomId);
    this.vacuums.delete(roomId);
    this.vacuumVelocities.delete(roomId);
    this.balls.delete(roomId);
    this.kicks.delete(roomId);
    this.portalModes.delete(roomId);
    this.wirings.delete(roomId);
    this.nextSlot.delete(roomId);
    this.emit({ type: 'room_closed', roomId });
  }

  /** Sends the joiner everyone else in the room, their LiveKit access and the room's objects. */
  private welcome(conn: string, roomId: string, room: Room, self: Peer): void {
    // The welcome carries everyone's current pose: start this recipient's fan-out from there.
    const now = this.opts.now();
    self.sent = new Map();
    for (const p of room.values()) {
      if (p !== self) {
        self.sent.set(p.id, { version: p.poseVersion, at: now });
      }
    }
    const vacuum = this.vacuums.get(roomId);
    const ball = this.balls.get(roomId);
    this.opts.out.send(conn, {
      type: 'welcome',
      selfId: self.id,
      resumeToken: self.resumeToken,
      color: self.color,
      spawn: { x: self.x, y: self.y, angle: self.angle },
      peers: [...room.values()].filter((p) => p.id !== self.id).map(peerInfo),
      livekit: this.opts.liveKitFor(roomId, self.id),
      objects: [...(vacuum ? [vacuumInfo(vacuum)] : []), ...(ball ? [ballInfo(ball)] : [])],
      portals: this.portalModes.get(roomId)?.on === true,
    });
  }

  /** Errors and closes a join. `reason` is what metrics see when it differs from `code` (a tab too old for `outdated`). */
  private reject(conn: string, code: RejectReason, message: string, close: number, reason: RejectReason = code): void {
    this.opts.out.send(conn, { type: 'error', code, message });
    this.opts.out.close(conn, close, code);
    this.emit({ type: 'rejected', reason });
  }

  // The world: bots, robot vacuums and balls.

  private spawnBots(roomId: string, room: Room, count: number): void {
    const { newToken, now } = this.opts;
    this.floor ??= floorTiles(this.opts.map);
    for (let i = 0; i < count; i++) {
      const bot: Peer = {
        id: newToken(),
        slot: this.takeSlot(roomId),
        ...placeBot(i, this.floor, this.opts.rng),
        cam: false,
        mic: false,
        avatar: null,
        picture: null,
        held: null,
        boombox: false,
        resumeToken: newToken(),
        conn: null,
        lastAcceptedAt: now(),
        disconnectedAt: null,
        ...freshTracking(now()),
        bot: true,
      };
      room.set(bot.id, bot);
    }
  }

  /** Walks every bot of every room with someone connected; fan-out sends their poses like a player's. */
  private stepBots(dt: number): void {
    const now = this.opts.now();
    for (const [roomId, room] of this.rooms) {
      if (!hasConnection(room)) {
        continue;
      }
      const portals = this.activePortals(roomId);
      for (const peer of room.values()) {
        if (peer.bot) {
          stepBot(this.opts.map, peer, dt, this.opts.rng, portals);
          peer.poseVersion++;
          peer.poseAt = now;
        }
      }
    }
  }

  private countBotRooms(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      if ([...room.values()].some((p) => p.bot)) {
        count++;
      }
    }
    return count;
  }

  private spawnVacuum(roomId: string): void {
    if (this.opts.vacuum) {
      const vacuum = createVacuum(this.vacuumNav(), this.opts.rng, this.opts.newToken(), {
        nearlyDone: this.opts.vacuumNearlyDone,
      });
      this.vacuums.set(roomId, vacuum);
    }
  }

  /** Steps each robot vacuum, bumping only connected people (never bots), and relays its pose as `object_state`. */
  private stepVacuums(dt: number): void {
    const nav = this.vacuumNav();
    for (const [roomId, vacuum] of this.vacuums) {
      const room = this.rooms.get(roomId);
      if (!room) {
        continue;
      }
      const portals = this.activePortals(roomId);
      const conns: string[] = [];
      const people: Point[] = [];
      for (const p of room.values()) {
        if (p.conn !== null && isPerson(p)) {
          conns.push(p.conn);
          people.push(portals === null ? p : { ...this.seenFrom(portals, vacuum, p) });
        }
      }
      if (conns.length === 0) {
        continue;
      }
      const { x, y } = vacuum;
      const event = stepVacuum(nav, vacuum, dt, this.opts.rng, people, portals);
      // A jump through a portal is not a speed: the robot knocks nothing for that step.
      const jumped = Math.hypot(vacuum.x - x, vacuum.y - y) > VACUUM_SPEED * dt * 2;
      this.vacuumVelocities.set(
        roomId,
        jumped ? { vx: 0, vy: 0 } : { vx: (vacuum.x - x) / dt, vy: (vacuum.y - y) / dt }
      );
      vacuum.seq++;
      this.opts.out.broadcast(conns, {
        type: 'object_state',
        id: vacuum.id,
        x: vacuum.x,
        y: vacuum.y,
        angle: vacuum.angle,
        seq: vacuum.seq,
        ...(event ? { event } : {}),
      });
    }
  }

  private spawnBall(roomId: string): void {
    if (this.opts.ball) {
      this.floor ??= floorTiles(this.opts.map);
      const tile = this.floor[Math.floor(this.opts.rng() * this.floor.length)] ?? this.opts.map.spawn;
      this.balls.set(roomId, createBall(this.opts.newToken(), tile.x + 0.5, tile.y + 0.5));
    }
  }

  /**
   * Steps each room's ball against its connected people (never bots) and its vacuum, and relays it as `object_state`
   * whenever it moved, stopped or was kicked. A ball at rest costs nothing.
   */
  private stepBalls(dt: number): void {
    const now = this.opts.now();
    for (const [roomId, ball] of this.balls) {
      const room = this.rooms.get(roomId);
      if (!room) {
        continue;
      }
      const portals = this.activePortals(roomId);
      const conns: string[] = [];
      const bodies: BallBody[] = [];
      for (const p of room.values()) {
        if (p.conn !== null && isPerson(p)) {
          conns.push(p.conn);
          const moving = now - p.poseAt <= MOVING_POSE_MS;
          const { x: bodyX, y: bodyY } = this.seenFrom(portals, ball, p);
          bodies.push({
            kind: 'person',
            x: bodyX,
            y: bodyY,
            vx: moving ? p.vx : 0,
            vy: moving ? p.vy : 0,
            radius: PLAYER_RADIUS,
          });
        }
      }
      if (conns.length === 0) {
        continue;
      }
      const vacuum = this.vacuums.get(roomId);
      if (vacuum) {
        const v = this.vacuumVelocities.get(roomId);
        const { x: bodyX, y: bodyY } = this.seenFrom(portals, ball, vacuum);
        bodies.push({
          kind: 'vacuum',
          x: bodyX,
          y: bodyY,
          vx: v?.vx ?? 0,
          vy: v?.vy ?? 0,
          radius: VACUUM_RADIUS,
        });
      }
      const { x, y, vx, vy } = ball;
      const event = stepBall(this.opts.map, ball, dt, bodies, portals);
      const kick = this.kicks.get(roomId);
      this.kicks.delete(roomId);
      const changed = ball.x !== x || ball.y !== y || ball.vx !== vx || ball.vy !== vy;
      if (!changed && !kick && !ballMoving(ball)) {
        continue;
      }
      ball.seq++;
      const said = kick ? { event: 'kick' as const, by: kick.by, k: kick.k } : event ? { event } : {};
      const { id, heading: angle } = ball;
      this.opts.out.broadcast(conns, {
        type: 'object_state',
        id,
        x: ball.x,
        y: ball.y,
        angle,
        seq: ball.seq,
        vx: ball.vx,
        vy: ball.vy,
        ...said,
      });
    }
  }

  /** The vacuum's map analysis, built on first use and shared by every room. */
  private vacuumNav(): VacuumNav {
    this.nav ??= createVacuumNav(this.opts.map);
    return this.nav;
  }

  // Portals.

  /**
   * Where `target` appears to be from `viewer`, one portal deep (contacts reach through at most one): the target
   * itself without portals. The result is shared scratch, valid until the next call.
   */
  private seenFrom(portals: Portals | null, viewer: Point, target: Point): Point {
    return portals === null ? target : apparentPosition(portals.map, portals, viewer, target, seen, 1);
  }

  private portalMode(roomId: string): { on: boolean; flippedAt: number } {
    let mode = this.portalModes.get(roomId);
    if (!mode) {
      mode = { on: false, flippedAt: Number.NEGATIVE_INFINITY };
      this.portalModes.set(roomId, mode);
    }
    return mode;
  }

  /** The room's doorway wiring while its portals are on, else null. */
  private activePortals(roomId: string): Portals | null {
    return this.portalModes.get(roomId)?.on === true ? this.wiring(roomId) : null;
  }

  /**
   * Under the room's current mode, or, for a second after a flip, the other one: a state sent just before the flip
   * reached its sender was made under the old mode.
   */
  private isPlausibleInRoom(roomId: string, peer: Peer, msg: StateMessage, now: number): boolean {
    const elapsedMs = now - peer.lastAcceptedAt;
    const current = this.activePortals(roomId);
    if (isPlausibleMove(this.opts.map, peer, msg, elapsedMs, current)) {
      return true;
    }
    const justFlipped =
      now - (this.portalModes.get(roomId)?.flippedAt ?? Number.NEGATIVE_INFINITY) < PORTALS_FLIP_GAP_MS;
    if (!justFlipped) {
      return false;
    }
    const other = current === null ? this.wiring(roomId) : null;
    return isPlausibleMove(this.opts.map, peer, msg, elapsedMs, other);
  }

  private wiring(roomId: string): Portals {
    let wiring = this.wirings.get(roomId);
    if (!wiring) {
      wiring = wirePortals(this.opts.map, roomId);
      this.wirings.set(roomId, wiring);
    }
    return wiring;
  }

  // Plumbing.

  /** The connection's room and peer, or null if it hasn't joined (or its peer is gone). */
  private peerOf(conn: string): { roomId: string; room: Room; peer: Peer } | null {
    const binding = this.conns.get(conn);
    const room = binding && this.rooms.get(binding.roomId);
    const peer = binding && room?.get(binding.peerId);
    return binding && room && peer ? { roomId: binding.roomId, room, peer } : null;
  }

  private gesture(conn: string, type: 'peer_drink' | 'peer_cheers'): void {
    const found = this.peerOf(conn);
    const now = this.opts.now();
    if (!found || found.peer.held === null || now - found.peer.lastGestureAt < DRINK_GAP_MS) {
      return;
    }
    found.peer.lastGestureAt = now;
    this.broadcast(found.room, found.peer.id, { type, id: found.peer.id });
  }

  /** Stores a peer's picture: its id goes on the wire, the picture into the snapshot. */
  private picture(dataUrl: string | null): { avatar: string | null; picture: string | null } {
    return { avatar: dataUrl === null ? null : this.avatars.add(dataUrl), picture: dataUrl };
  }

  private takeSlot(roomId: string): number {
    const slot = this.nextSlot.get(roomId) ?? 0;
    this.nextSlot.set(roomId, slot + 1);
    return slot;
  }

  /** Sends to every connected peer in the room except `exceptId`. */
  private broadcast(room: Room, exceptId: string, msg: ServerMessage): void {
    const conns: string[] = [];
    for (const p of room.values()) {
      if (p.id !== exceptId && p.conn !== null) {
        conns.push(p.conn);
      }
    }
    if (conns.length > 0) {
      this.opts.out.broadcast(conns, msg);
    }
  }

  private emit(e: LobbyEvent): void {
    this.opts.onEvent?.(e);
  }
}
