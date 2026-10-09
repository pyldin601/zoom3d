// Room membership, colours, resume grace and move validation. Pure: no sockets or timers.
import {
  type BoomboxMessage,
  DRINK_GAP_MS,
  type GameMap,
  type HeldMessage,
  type IceServer,
  isPlausibleMove,
  isValidAvatar,
  isValidRoomId,
  type JoinMessage,
  MAX_PEERS,
  type MediaMessage,
  PEER_COLORS,
  type PeerInfo,
  RESUME_GRACE_MS,
  type ServerMessage,
  type SignalMessage,
  type StateMessage,
  sanitizeName,
  spawnPoint,
} from '@zoom3d/shared';

export const CLOSE_ROOM_FULL = 4001;
export const CLOSE_INVALID = 4002;
export const CLOSE_REPLACED = 4003;

export interface Outbox {
  send(connId: string, msg: ServerMessage): void;
  close(connId: string, code: number, reason: string): void;
}

export interface LobbyOptions {
  map: GameMap;
  out: Outbox;
  now: () => number;
  rng: () => number;
  /** Creates peer ids and resume tokens. */
  newToken: () => string;
  graceMs?: number;
  iceServersFor?: (peerId: string) => IceServer[];
}

interface Peer extends PeerInfo {
  resumeToken: string;
  conn: string | null;
  lastAcceptedAt: number;
  /** When this peer's last sip was relayed (not shared: sips are never stored). */
  lastDrinkAt: number;
  disconnectedAt: number | null;
}

type Room = Map<string, Peer>;

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

  constructor(private readonly opts: LobbyOptions) {
    this.graceMs = opts.graceMs ?? RESUME_GRACE_MS;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  peerCount(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
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
    const resumable = [...room.values()].find((p) => p.resumeToken === msg.resumeToken);
    if (msg.resumeToken !== undefined && resumable) {
      // The client often notices a dead link before the server does: hand the slot to the new connection.
      if (resumable.conn !== null) {
        const stale = resumable.conn;
        this.conns.delete(stale);
        this.opts.out.close(stale, CLOSE_REPLACED, 'replaced');
      }
      resumable.conn = conn;
      resumable.disconnectedAt = null;
      this.conns.set(conn, { roomId: msg.roomId, peerId: resumable.id });
      this.welcome(conn, room, resumable);
      return;
    }
    if (room.size >= MAX_PEERS) {
      this.reject(conn, 'room_full', 'This room is full', CLOSE_ROOM_FULL);
      return;
    }

    const used = new Set([...room.values()].map((p) => p.color));
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
      lastDrinkAt: Number.NEGATIVE_INFINITY,
      resumeToken: this.opts.newToken(),
      conn,
      lastAcceptedAt: this.opts.now(),
      disconnectedAt: null,
    };
    room.set(peer.id, peer);
    this.rooms.set(msg.roomId, room);
    this.conns.set(conn, { roomId: msg.roomId, peerId: peer.id });
    this.welcome(conn, room, peer);
    this.broadcast(room, peer.id, { type: 'peer_joined', peer: info(peer) });
  }

  state(conn: string, msg: StateMessage): void {
    const found = this.lookup(conn);
    if (!found) {
      return;
    }
    const { room, peer } = found;
    const now = this.opts.now();
    if (!isPlausibleMove(this.opts.map, peer, msg, now - peer.lastAcceptedAt)) {
      this.opts.out.send(conn, { type: 'correction', x: peer.x, y: peer.y, angle: peer.angle, seq: msg.seq });
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

  /** Relays a sip, only from a peer holding a drink and at most once per DRINK_GAP_MS. */
  drink(conn: string): void {
    const found = this.lookup(conn);
    const now = this.opts.now();
    if (!found || found.peer.held === null || now - found.peer.lastDrinkAt < DRINK_GAP_MS) {
      return;
    }
    found.peer.lastDrinkAt = now;
    this.broadcast(found.room, found.peer.id, { type: 'peer_drink', id: found.peer.id });
  }

  /** Relays WebRTC signalling only to another live peer of the sender's room. */
  signal(conn: string, msg: SignalMessage): void {
    const found = this.lookup(conn);
    const target = found?.room.get(msg.to);
    if (!found || !target || target.id === found.peer.id || target.conn === null) {
      return;
    }
    this.opts.out.send(target.conn, { type: 'signal', from: found.peer.id, payload: msg.payload });
  }

  disconnect(conn: string): void {
    const found = this.lookup(conn);
    this.conns.delete(conn);
    if (!found) {
      return;
    }
    found.peer.conn = null;
    found.peer.disconnectedAt = this.opts.now();
  }

  /** Expires peers whose grace has run out and deletes empty rooms. */
  tick(): void {
    const now = this.opts.now();
    for (const [roomId, room] of this.rooms) {
      for (const peer of [...room.values()]) {
        if (peer.disconnectedAt !== null && now - peer.disconnectedAt >= this.graceMs) {
          room.delete(peer.id);
          this.broadcast(room, peer.id, { type: 'peer_left', id: peer.id });
        }
      }
      if (room.size === 0) {
        this.rooms.delete(roomId);
      }
    }
  }

  private lookup(conn: string): { room: Room; peer: Peer } | null {
    const binding = this.conns.get(conn);
    const room = binding && this.rooms.get(binding.roomId);
    const peer = binding && room?.get(binding.peerId);
    return room && peer ? { room, peer } : null;
  }

  private welcome(conn: string, room: Room, self: Peer): void {
    this.opts.out.send(conn, {
      type: 'welcome',
      selfId: self.id,
      resumeToken: self.resumeToken,
      color: self.color,
      spawn: { x: self.x, y: self.y, angle: self.angle },
      peers: [...room.values()].filter((p) => p.id !== self.id).map(info),
      iceServers: this.opts.iceServersFor?.(self.id) ?? [],
    });
  }

  private broadcast(room: Room, exceptId: string, msg: ServerMessage): void {
    for (const p of room.values()) {
      if (p.id !== exceptId && p.conn !== null) {
        this.opts.out.send(p.conn, msg);
      }
    }
  }

  private reject(conn: string, code: 'room_full' | 'invalid_room' | 'invalid_name', message: string, close: number) {
    this.opts.out.send(conn, { type: 'error', code, message });
    this.opts.out.close(conn, close, code);
  }
}
