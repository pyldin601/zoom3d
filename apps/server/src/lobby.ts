// Room membership, colours, resume grace and move validation, plus opt-in wandering bots and each room's robot vacuum.
// Pure: no sockets or timers (the server drives tick() and stepWorld()).
import {
  type BoomboxMessage,
  DRINK_GAP_MS,
  type GameMap,
  type HeldMessage,
  isPlausibleMove,
  isValidAvatar,
  isValidRoomId,
  isWallAt,
  type JoinMessage,
  type LiveKitAccess,
  MAX_PEERS,
  type MediaMessage,
  type PeerInfo,
  PROTOCOL_VERSION,
  RESUME_GRACE_MS,
  type ServerMessage,
  type StateMessage,
  sanitizeName,
  spawnPoint,
  stepPlayer,
} from '@zoom3d/shared';
import { AvatarStore } from './avatars';
import { pickColor } from './colors';
import { type SentLog, selectBatch } from './fanout';
import {
  createVacuum,
  restoreVacuum,
  saveVacuum,
  stepVacuum,
  type Vacuum,
  type VacuumSave,
  vacuumInfo,
} from './vacuum';
import { createVacuumNav, type Point, type VacuumNav } from './vacuum-nav';

export const CLOSE_ROOM_FULL = 4001;
export const CLOSE_INVALID = 4002;
export const CLOSE_REPLACED = 4003;

/** Rooms that may have bots at once on one server, so a public link can't load casa with thousands. */
export const MAX_BOT_ROOMS = 3;
/** Muted colours, never a player colour, so people stand out from bots. */
export const BOT_COLORS = ['#7f8c8d', '#95a5a6', '#8d7b68', '#6c7a89', '#a09080'] as const;
/** Bots wander slower than walking pace. */
const BOT_SPEED = 0.6;
/** On average, a bot that isn't blocked turns on its own about this often. */
const BOT_TURN_EVERY_S = 8;
const FORWARD = { forward: 1, strafe: 0, turn: 0 };

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
}

interface Peer extends PeerInfo {
  resumeToken: string;
  conn: string | null;
  lastAcceptedAt: number;
  /** When this peer's last sip or cheers was relayed (not shared: gestures are never stored). */
  lastGestureAt: number;
  disconnectedAt: number | null;
  /** The picture itself (a JPEG data URL) behind `avatar`, its id in the avatar store. */
  picture: string | null;
  /** Bumped whenever the pose changes, so fan-out sends only what moved. */
  poseVersion: number;
  /** What this peer, as a recipient, was last sent of each other peer (6d spec §2.1). */
  sent: SentLog;
  /** Set on a wandering bot: no connection, never expires, never resumable, never saved. */
  bot?: true;
}

type Room = Map<string, Peer>;

const isPerson = (p: Peer) => p.bot === undefined;

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
  rooms: { id: string; peers: SnapshotPeer[]; vacuum?: VacuumSave }[];
}

const info = ({ id, slot, name, color, x, y, angle, cam, mic, avatar, held, boombox }: Peer): PeerInfo => ({
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

export class Lobby {
  private readonly rooms = new Map<string, Room>();
  private readonly conns = new Map<string, { roomId: string; peerId: string }>();
  private readonly graceMs: number;
  private floor: { x: number; y: number }[] | null = null;
  private nav: VacuumNav | null = null;
  /** Each room's robot vacuum, by room id. Not a peer: it never keeps a room open. */
  private readonly vacuums = new Map<string, Vacuum>();
  /** Each room's next peer slot: a counter, so a late batch can never move the wrong peer. */
  private readonly nextSlot = new Map<string, number>();
  private readonly avatars = new AvatarStore();
  private readonly moved = { x: 0, y: 0, angle: 0 };

  constructor(private readonly opts: LobbyOptions) {
    this.graceMs = opts.graceMs ?? RESUME_GRACE_MS;
  }

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

  join(conn: string, msg: JoinMessage): void {
    if (this.conns.has(conn)) {
      return;
    }
    // Tabs opened before 6d send no version and only know fatal invalid_room ("Couldn't join this room").
    if (msg.v === undefined) {
      this.reject(conn, 'invalid_room', OUTDATED, CLOSE_INVALID, 'outdated');
      return;
    }
    if (msg.v < PROTOCOL_VERSION) {
      this.reject(conn, 'outdated', OUTDATED, CLOSE_INVALID);
      return;
    }
    const name = sanitizeName(msg.name);
    if (!isValidRoomId(msg.roomId)) {
      this.reject(conn, 'invalid_room', 'Invalid room link', CLOSE_INVALID);
      return;
    }
    if (name === null) {
      this.reject(conn, 'invalid_name', 'Invalid name', CLOSE_INVALID);
      return;
    }

    const room = this.rooms.get(msg.roomId) ?? new Map<string, Peer>();
    const resumable = [...room.values()].find((p) => isPerson(p) && p.resumeToken === msg.resumeToken);
    if (msg.resumeToken !== undefined && resumable) {
      // The client often notices a dead link before the server does: hand the slot to the new connection.
      const replaced = resumable.conn !== null;
      if (resumable.conn !== null) {
        const stale = resumable.conn;
        this.conns.delete(stale);
        this.opts.out.close(stale, CLOSE_REPLACED, 'replaced');
      }
      resumable.conn = conn;
      resumable.disconnectedAt = null;
      this.conns.set(conn, { roomId: msg.roomId, peerId: resumable.id });
      this.welcome(conn, msg.roomId, room, resumable);
      this.emit({
        type: 'joined',
        roomId: msg.roomId,
        peerId: resumable.id,
        resumed: true,
        replaced,
        peers: this.people(room),
      });
      return;
    }
    if (this.people(room) >= MAX_PEERS) {
      this.reject(conn, 'room_full', 'This room is full', CLOSE_ROOM_FULL);
      return;
    }

    const used = new Set([...room.values()].filter(isPerson).map((p) => p.color));
    const color = pickColor(used);
    const spawn = spawnPoint(this.opts.map, this.opts.rng);
    const peer: Peer = {
      id: this.opts.newToken(),
      slot: this.takeSlot(msg.roomId),
      name,
      color,
      ...spawn,
      cam: false,
      mic: false,
      ...this.picture(isValidAvatar(msg.avatar) ? msg.avatar : null),
      held: null,
      boombox: false,
      lastGestureAt: Number.NEGATIVE_INFINITY,
      resumeToken: this.opts.newToken(),
      conn,
      lastAcceptedAt: this.opts.now(),
      disconnectedAt: null,
      poseVersion: 0,
      sent: new Map(),
    };
    if (room.size === 0) {
      this.emit({ type: 'room_opened', roomId: msg.roomId });
      if (msg.bots && this.botRooms() < MAX_BOT_ROOMS) {
        this.spawnBots(msg.roomId, room, msg.bots);
        this.emit({ type: 'bots_spawned', roomId: msg.roomId, count: msg.bots });
      }
      this.spawnVacuum(msg.roomId);
    }
    room.set(peer.id, peer);
    this.rooms.set(msg.roomId, room);
    this.conns.set(conn, { roomId: msg.roomId, peerId: peer.id });
    this.welcome(conn, msg.roomId, room, peer);
    this.broadcast(room, peer.id, { type: 'peer_joined', peer: info(peer) });
    // peer_joined carried the newcomer's pose: nobody needs it again until it moves.
    const now = this.opts.now();
    for (const p of room.values()) {
      if (p !== peer) {
        p.sent.set(peer.id, { version: peer.poseVersion, at: now });
      }
    }
    this.emit({
      type: 'joined',
      roomId: msg.roomId,
      peerId: peer.id,
      resumed: false,
      replaced: false,
      peers: this.people(room),
    });
  }

  state(conn: string, msg: StateMessage): void {
    const found = this.lookup(conn);
    if (!found) {
      return;
    }
    const { roomId, peer } = found;
    const now = this.opts.now();
    if (!isPlausibleMove(this.opts.map, peer, msg, now - peer.lastAcceptedAt)) {
      this.opts.out.send(conn, { type: 'correction', x: peer.x, y: peer.y, angle: peer.angle, seq: msg.seq });
      this.emit({ type: 'move_corrected', roomId, peerId: peer.id });
      return;
    }
    // An idle heartbeat repeats the pose: it keeps the move check's clock, but there is nothing to send.
    if (msg.x !== peer.x || msg.y !== peer.y || msg.angle !== peer.angle) {
      peer.x = msg.x;
      peer.y = msg.y;
      peer.angle = msg.angle;
      peer.poseVersion++;
    }
    peer.lastAcceptedAt = now;
  }

  /**
   * One server tick of state (6d spec §2.1): each connected person gets one `peers` batch of the poses that changed
   * since they were last sent to them, near ones every tick and far ones at most every FAR_INTERVAL_MS.
   */
  fanOut(): void {
    const now = this.opts.now();
    for (const room of this.rooms.values()) {
      for (const p of room.values()) {
        if (p.conn === null) {
          continue;
        }
        const s = selectBatch(p, room.values(), p.sent, now);
        if (s.length > 0) {
          this.opts.out.send(p.conn, { type: 'peers', s });
        }
      }
    }
  }

  media(conn: string, msg: MediaMessage): void {
    const found = this.lookup(conn);
    if (!found) {
      return;
    }
    found.peer.cam = msg.cam;
    found.peer.mic = msg.mic;
    this.broadcast(found.room, found.peer.id, {
      type: 'peer_media',
      id: found.peer.id,
      cam: msg.cam,
      mic: msg.mic,
    });
  }

  held(conn: string, msg: HeldMessage): void {
    const found = this.lookup(conn);
    if (!found) {
      return;
    }
    found.peer.held = msg.item;
    this.broadcast(found.room, found.peer.id, { type: 'peer_held', id: found.peer.id, item: msg.item });
  }

  boombox(conn: string, msg: BoomboxMessage): void {
    const found = this.lookup(conn);
    if (!found) {
      return;
    }
    found.peer.boombox = msg.on;
    this.broadcast(found.room, found.peer.id, { type: 'peer_boombox', id: found.peer.id, on: msg.on });
  }

  /** Relays a sip, only from a peer holding a drink and at most one gesture per DRINK_GAP_MS. */
  drink(conn: string): void {
    this.gesture(conn, 'peer_drink');
  }

  /** Relays a cheers under the same rules as a sip, sharing its gap. */
  cheers(conn: string): void {
    this.gesture(conn, 'peer_cheers');
  }

  private gesture(conn: string, type: 'peer_drink' | 'peer_cheers'): void {
    const found = this.lookup(conn);
    const now = this.opts.now();
    if (!found || found.peer.held === null || now - found.peer.lastGestureAt < DRINK_GAP_MS) {
      return;
    }
    found.peer.lastGestureAt = now;
    this.broadcast(found.room, found.peer.id, { type, id: found.peer.id });
  }

  disconnect(conn: string): void {
    const found = this.lookup(conn);
    this.conns.delete(conn);
    if (!found) {
      return;
    }
    found.peer.conn = null;
    found.peer.disconnectedAt = this.opts.now();
    this.emit({ type: 'disconnected', roomId: found.roomId, peerId: found.peer.id });
  }

  /** Expires peers whose grace has run out and deletes empty rooms. */
  tick(): void {
    const now = this.opts.now();
    for (const [roomId, room] of this.rooms) {
      for (const peer of [...room.values()]) {
        if (peer.disconnectedAt !== null && now - peer.disconnectedAt >= this.graceMs) {
          room.delete(peer.id);
          if (peer.avatar !== null) {
            this.avatars.release(peer.avatar);
          }
          for (const p of room.values()) {
            p.sent.delete(peer.id);
          }
          this.broadcast(room, peer.id, { type: 'peer_left', id: peer.id });
          this.emit({ type: 'left', roomId, peerId: peer.id, peers: this.people(room) });
        }
      }
      // Bots never keep a room alive: it closes with its last person.
      if (this.people(room) === 0) {
        this.rooms.delete(roomId);
        this.vacuums.delete(roomId);
        this.nextSlot.delete(roomId);
        this.emit({ type: 'room_closed', roomId });
      }
    }
  }

  snapshot(): LobbySnapshot {
    return {
      version: 1,
      rooms: [...this.rooms].map(([id, room]) => {
        const vacuum = this.vacuums.get(id);
        return {
          id,
          peers: [...room.values()].filter(isPerson).map((p) => {
            // The picture itself, as before 6d: avatar ids mean nothing to the next process.
            const { slot: _, ...saved } = info(p);
            return { ...saved, avatar: p.picture, resumeToken: p.resumeToken, lastAcceptedAt: p.lastAcceptedAt };
          }),
          ...(vacuum ? { vacuum: saveVacuum(this.vacuumNav(), vacuum) } : {}),
        };
      }),
    };
  }

  /** Loads a snapshot into an empty lobby. Every slot starts a fresh grace period, waiting for its owner to resume. */
  restore(snap: LobbySnapshot): void {
    const now = this.opts.now();
    for (const { id, peers, vacuum } of snap.rooms) {
      const room: Room = new Map();
      for (const p of peers) {
        room.set(p.id, {
          ...p,
          ...this.picture(p.avatar),
          slot: this.takeSlot(id),
          conn: null,
          disconnectedAt: now,
          lastGestureAt: Number.NEGATIVE_INFINITY,
          poseVersion: 0,
          sent: new Map(),
        });
      }
      this.rooms.set(id, room);
      this.emit({ type: 'room_opened', roomId: id });
      // A robot saved on another map (or none saved) starts afresh.
      const restored = this.opts.vacuum && vacuum ? restoreVacuum(this.vacuumNav(), vacuum) : null;
      if (restored) {
        this.vacuums.set(id, restored);
      } else {
        this.spawnVacuum(id);
      }
    }
  }

  /** Moves every room's bots and robot vacuum; rooms with nobody connected stand still. */
  stepWorld(dtMs: number): void {
    this.stepBots(dtMs);
    this.stepVacuums(dtMs);
  }

  /**
   * Moves every bot of every room with someone connected: straight on, a random new heading on hitting a wall, now
   * and then a turn of its own. Fan-out sends their poses like a player's.
   */
  private stepBots(dtMs: number): void {
    const dt = dtMs / 1000;
    const { map, rng } = this.opts;
    for (const room of this.rooms.values()) {
      if (![...room.values()].some((p) => p.conn !== null)) {
        continue;
      }
      for (const bot of room.values()) {
        if (!bot.bot) {
          continue;
        }
        const step = dt * BOT_SPEED;
        const to = stepPlayer(map, bot, FORWARD, step, this.moved);
        const travelled = Math.hypot(to.x - bot.x, to.y - bot.y);
        if (travelled < step * 0.5) {
          bot.angle = rng() * Math.PI * 2;
        } else {
          bot.x = to.x;
          bot.y = to.y;
          if (rng() < dt / BOT_TURN_EVERY_S) {
            bot.angle += (rng() - 0.5) * Math.PI;
          }
        }
        bot.poseVersion++;
      }
    }
  }

  /** Steps each robot vacuum, bumping only connected people (never bots), and relays its pose as `object_state`. */
  private stepVacuums(dtMs: number): void {
    const dt = dtMs / 1000;
    const nav = this.vacuumNav();
    for (const [roomId, v] of this.vacuums) {
      const room = this.rooms.get(roomId);
      if (!room) {
        continue;
      }
      const conns: string[] = [];
      const people: Point[] = [];
      for (const p of room.values()) {
        if (p.conn !== null && isPerson(p)) {
          conns.push(p.conn);
          people.push(p);
        }
      }
      if (conns.length === 0) {
        continue;
      }
      const event = stepVacuum(nav, v, dt, this.opts.rng, people);
      v.seq++;
      this.opts.out.broadcast(conns, {
        type: 'object_state',
        id: v.id,
        x: v.x,
        y: v.y,
        angle: v.angle,
        seq: v.seq,
        ...(event ? { event } : {}),
      });
    }
  }

  private spawnVacuum(roomId: string): void {
    if (this.opts.vacuum) {
      const v = createVacuum(this.vacuumNav(), this.opts.rng, this.opts.newToken(), {
        nearlyDone: this.opts.vacuumNearlyDone,
      });
      this.vacuums.set(roomId, v);
    }
  }

  private vacuumNav(): VacuumNav {
    this.nav ??= createVacuumNav(this.opts.map);
    return this.nav;
  }

  /** The JPEG served at `GET /avatar/<id>`, while someone in any room uses it. */
  avatar(id: string): Buffer | null {
    return this.avatars.get(id);
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

  private spawnBots(roomId: string, room: Room, count: number): void {
    const { map, rng, newToken, now } = this.opts;
    this.floor ??= floorTiles(map);
    for (let i = 0; i < count; i++) {
      const tile = this.floor[Math.floor(rng() * this.floor.length)] as { x: number; y: number };
      const bot: Peer = {
        id: newToken(),
        slot: this.takeSlot(roomId),
        name: `Bot ${String(i + 1).padStart(3, '0')}`,
        color: BOT_COLORS[i % BOT_COLORS.length] as string,
        x: tile.x + 0.5,
        y: tile.y + 0.5,
        angle: rng() * Math.PI * 2,
        cam: false,
        mic: false,
        avatar: null,
        picture: null,
        held: null,
        boombox: false,
        resumeToken: newToken(),
        conn: null,
        lastAcceptedAt: now(),
        lastGestureAt: Number.NEGATIVE_INFINITY,
        disconnectedAt: null,
        poseVersion: 0,
        sent: new Map(),
        bot: true,
      };
      room.set(bot.id, bot);
    }
  }

  private people(room: Room): number {
    let n = 0;
    for (const p of room.values()) {
      if (isPerson(p)) {
        n++;
      }
    }
    return n;
  }

  private botRooms(): number {
    let n = 0;
    for (const room of this.rooms.values()) {
      if ([...room.values()].some((p) => p.bot)) {
        n++;
      }
    }
    return n;
  }

  private lookup(conn: string): { roomId: string; room: Room; peer: Peer } | null {
    const binding = this.conns.get(conn);
    const room = binding && this.rooms.get(binding.roomId);
    const peer = binding && room?.get(binding.peerId);
    return binding && room && peer ? { roomId: binding.roomId, room, peer } : null;
  }

  private emit(e: LobbyEvent): void {
    this.opts.onEvent?.(e);
  }

  private welcome(conn: string, roomId: string, room: Room, self: Peer): void {
    const vacuum = this.vacuums.get(roomId);
    // The welcome carries everyone's current pose: start this recipient's fan-out from there.
    const now = this.opts.now();
    self.sent = new Map();
    for (const p of room.values()) {
      if (p !== self) {
        self.sent.set(p.id, { version: p.poseVersion, at: now });
      }
    }
    this.opts.out.send(conn, {
      type: 'welcome',
      selfId: self.id,
      resumeToken: self.resumeToken,
      color: self.color,
      spawn: { x: self.x, y: self.y, angle: self.angle },
      peers: [...room.values()].filter((p) => p.id !== self.id).map(info),
      livekit: this.opts.liveKitFor(roomId, self.id),
      objects: vacuum ? [vacuumInfo(vacuum)] : [],
    });
  }

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

  private reject(conn: string, code: RejectReason, message: string, close: number, reason: RejectReason = code) {
    this.opts.out.send(conn, { type: 'error', code, message });
    this.opts.out.close(conn, close, code);
    this.emit({ type: 'rejected', reason });
  }
}

/** Every floor tile; the map validator guarantees each one is reachable from the spawn. */
function floorTiles(map: GameMap): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!isWallAt(map, x + 0.5, y + 0.5)) {
        tiles.push({ x, y });
      }
    }
  }
  return tiles;
}
