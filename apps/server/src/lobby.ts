// Room membership, colours, resume grace and move validation, plus opt-in wandering bots. Pure: no sockets or
// timers (the server drives tick() and stepBots()).
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
  PEER_COLORS,
  type PeerInfo,
  RESUME_GRACE_MS,
  type ServerMessage,
  type StateMessage,
  sanitizeName,
  spawnPoint,
  stepPlayer,
} from '@zoom3d/shared';

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

type RejectReason = 'room_full' | 'invalid_room' | 'invalid_name';

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
}

interface Peer extends PeerInfo {
  resumeToken: string;
  conn: string | null;
  lastAcceptedAt: number;
  /** When this peer's last sip or cheers was relayed (not shared: gestures are never stored). */
  lastGestureAt: number;
  disconnectedAt: number | null;
  /** Set on a wandering bot: no connection, never expires, never resumable, never saved. */
  bot?: { seq: number };
}

type Room = Map<string, Peer>;

const isPerson = (p: Peer) => p.bot === undefined;

/** A peer as written to the restart snapshot: no connection, no gesture timing. */
export interface SnapshotPeer extends PeerInfo {
  resumeToken: string;
  lastAcceptedAt: number;
}

/** Bump `version` when SnapshotPeer changes in a way parsePeerInfo's defaults can't absorb. */
export interface LobbySnapshot {
  version: 1;
  rooms: { id: string; peers: SnapshotPeer[] }[];
}

const info = ({ id, name, color, x, y, angle, cam, mic, avatar, held, boombox }: Peer): PeerInfo => ({
  id,
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
    const color = PEER_COLORS.find((c) => !used.has(c)) ?? PEER_COLORS[0];
    const spawn = spawnPoint(this.opts.map, this.opts.rng);
    const peer: Peer = {
      id: this.opts.newToken(),
      name,
      color,
      ...spawn,
      cam: false,
      mic: false,
      avatar: isValidAvatar(msg.avatar) ? msg.avatar : null,
      held: null,
      boombox: false,
      lastGestureAt: Number.NEGATIVE_INFINITY,
      resumeToken: this.opts.newToken(),
      conn,
      lastAcceptedAt: this.opts.now(),
      disconnectedAt: null,
    };
    if (room.size === 0) {
      this.emit({ type: 'room_opened', roomId: msg.roomId });
      if (msg.bots && this.botRooms() < MAX_BOT_ROOMS) {
        this.spawnBots(room, msg.bots);
        this.emit({ type: 'bots_spawned', roomId: msg.roomId, count: msg.bots });
      }
    }
    room.set(peer.id, peer);
    this.rooms.set(msg.roomId, room);
    this.conns.set(conn, { roomId: msg.roomId, peerId: peer.id });
    this.welcome(conn, msg.roomId, room, peer);
    this.broadcast(room, peer.id, { type: 'peer_joined', peer: info(peer) });
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
    const { roomId, room, peer } = found;
    const now = this.opts.now();
    if (!isPlausibleMove(this.opts.map, peer, msg, now - peer.lastAcceptedAt)) {
      this.opts.out.send(conn, { type: 'correction', x: peer.x, y: peer.y, angle: peer.angle, seq: msg.seq });
      this.emit({ type: 'move_corrected', roomId, peerId: peer.id });
      return;
    }
    peer.x = msg.x;
    peer.y = msg.y;
    peer.angle = msg.angle;
    peer.lastAcceptedAt = now;
    this.broadcast(room, peer.id, {
      type: 'peer_state',
      id: peer.id,
      x: msg.x,
      y: msg.y,
      angle: msg.angle,
      seq: msg.seq,
    });
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
          this.broadcast(room, peer.id, { type: 'peer_left', id: peer.id });
          this.emit({ type: 'left', roomId, peerId: peer.id, peers: this.people(room) });
        }
      }
      // Bots never keep a room alive: it closes with its last person.
      if (this.people(room) === 0) {
        this.rooms.delete(roomId);
        this.emit({ type: 'room_closed', roomId });
      }
    }
  }

  snapshot(): LobbySnapshot {
    return {
      version: 1,
      rooms: [...this.rooms].map(([id, room]) => ({
        id,
        peers: [...room.values()].filter(isPerson).map((p) => ({
          ...info(p),
          resumeToken: p.resumeToken,
          lastAcceptedAt: p.lastAcceptedAt,
        })),
      })),
    };
  }

  /** Loads a snapshot into an empty lobby. Every slot starts a fresh grace period, waiting for its owner to resume. */
  restore(snap: LobbySnapshot): void {
    const now = this.opts.now();
    for (const { id, peers } of snap.rooms) {
      const room: Room = new Map();
      for (const p of peers) {
        room.set(p.id, { ...p, conn: null, disconnectedAt: now, lastGestureAt: Number.NEGATIVE_INFINITY });
      }
      this.rooms.set(id, room);
      this.emit({ type: 'room_opened', roomId: id });
    }
  }

  /**
   * Moves every bot of every room with someone connected, like a robot vacuum: straight on, a random new heading on
   * hitting a wall, now and then a turn of its own. Each pose is relayed like a player's (`peer_state`).
   */
  stepBots(dtMs: number): void {
    const dt = dtMs / 1000;
    const { map, rng } = this.opts;
    for (const room of this.rooms.values()) {
      const conns = [...room.values()].filter((p) => p.conn !== null).map((p) => p.conn as string);
      if (conns.length === 0) {
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
        bot.bot.seq++;
        this.opts.out.broadcast(conns, {
          type: 'peer_state',
          id: bot.id,
          x: bot.x,
          y: bot.y,
          angle: bot.angle,
          seq: bot.bot.seq,
        });
      }
    }
  }

  private spawnBots(room: Room, count: number): void {
    const { map, rng, newToken, now } = this.opts;
    this.floor ??= floorTiles(map);
    for (let i = 0; i < count; i++) {
      const tile = this.floor[Math.floor(rng() * this.floor.length)] as { x: number; y: number };
      const bot: Peer = {
        id: newToken(),
        name: `Bot ${String(i + 1).padStart(3, '0')}`,
        color: BOT_COLORS[i % BOT_COLORS.length] as string,
        x: tile.x + 0.5,
        y: tile.y + 0.5,
        angle: rng() * Math.PI * 2,
        cam: false,
        mic: false,
        avatar: null,
        held: null,
        boombox: false,
        resumeToken: newToken(),
        conn: null,
        lastAcceptedAt: now(),
        lastGestureAt: Number.NEGATIVE_INFINITY,
        disconnectedAt: null,
        bot: { seq: 0 },
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
    this.opts.out.send(conn, {
      type: 'welcome',
      selfId: self.id,
      resumeToken: self.resumeToken,
      color: self.color,
      spawn: { x: self.x, y: self.y, angle: self.angle },
      peers: [...room.values()].filter((p) => p.id !== self.id).map(info),
      livekit: this.opts.liveKitFor(roomId, self.id),
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

  private reject(conn: string, code: RejectReason, message: string, close: number) {
    this.opts.out.send(conn, { type: 'error', code, message });
    this.opts.out.close(conn, close, code);
    this.emit({ type: 'rejected', reason: code });
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
