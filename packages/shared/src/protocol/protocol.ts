// Multiplayer wire protocol: message types, constants and strict validators.

import type { SequenceKind } from '../portals/sequence';

/** People per room (bots don't count). To revisit after the 100-person load test (D21). */
export const MAX_PEERS = 128;
/** Sent in every join; a join without it, or with an older one, comes from a tab opened before an update. */
export const PROTOCOL_VERSION = 5;
/** Bots a room may be created with (opt-in via the room link's `?bots=N`), outside MAX_PEERS. */
export const MAX_BOTS = 100;
export const NAME_MAX_CHARS = 24;
/** Client → server. A join carrying a full-size avatar is ≈ 12 KB. */
export const MAX_MESSAGE_BYTES = 16384;
/** Server → client: avatars travel over HTTP, so a welcome listing 128 people and 100 bots is ≈ 50 KB. */
export const MAX_SERVER_MESSAGE_BYTES = 131072;
export const AVATAR_SIZE_PX = 128;
export const AVATAR_MAX_CHARS = 12_000;
export const RESUME_GRACE_MS = 30000;
export const STATE_INTERVAL_MS = 66;
export const IDLE_INTERVAL_MS = 1000;
/**
 * How far in the past near peers and objects are drawn. A pose waits up to a tick for its batch, and two moves landing
 * in one tick double the gap to the next, so less than two ticks plus jitter would run the buffer dry.
 */
export const INTERP_DELAY_MS = 150;
/** The server sends each client one batch of poses per tick (6d spec §2.1): the clients' own send rate. */
export const FANOUT_TICK_MS = 66;
/** Peers within this many tiles (straight line) are sent every tick... */
export const NEAR_TILES = 16;
/** ...and farther ones at most this often. */
export const FAR_INTERVAL_MS = 500;
export const RATE_PER_SEC = 60;
export const RATE_BURST = 200;
export const PEER_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#ffe119',
  '#f58231',
  '#911eb4',
  '#46f0f0',
  '#f032e6',
  '#bcf60c',
] as const;

export interface PeerInfo {
  id: string;
  /** Small per-room number that names this peer in `peers` batches; never reused within a room's life. */
  slot: number;
  name: string;
  color: string;
  x: number;
  y: number;
  angle: number;
  cam: boolean;
  mic: boolean;
  /** Avatar id (see isAvatarId): the picture at avatarPath(id), shown while the camera is off. */
  avatar: string | null;
  /** What the peer holds in its hand, if anything. */
  held: HeldItem | null;
  /** Whether the peer is playing its boombox (boombox spec §6). */
  boombox: boolean;
}

/** A server-driven thing in the room that isn't a person: the robot vacuum and the ball (robot vacuum spec §4). */
export type ObjectKind = 'vacuum' | 'ball';
/** Something an object did on one step, for its sound (robot vacuum spec §5.2, ball spec §4). */
export type ObjectEvent = 'bump' | 'lost' | 'kick' | 'bounce';
const OBJECT_KINDS: readonly ObjectKind[] = ['vacuum', 'ball'];
const OBJECT_EVENTS: readonly ObjectEvent[] = ['bump', 'lost', 'kick', 'bounce'];

export interface ObjectInfo {
  id: string;
  kind: ObjectKind;
  x: number;
  y: number;
  angle: number;
  /** The ball's velocity in tiles/s; absent when still, and on the vacuum. */
  vx?: number;
  vy?: number;
}

/** Where and how a peer joins the room's LiveKit SFU (LiveKit spec §3). */
export interface LiveKitAccess {
  url: string;
  token: string;
}

export type JoinMessage = {
  type: 'join';
  roomId: string;
  name: string;
  resumeToken?: string;
  avatar?: string;
  /** Asks for this many wandering bots if the join creates the room (testing large rooms). */
  bots?: number;
  /** PROTOCOL_VERSION of the client; missing from tabs opened before 6d. */
  v?: number;
};
export type StateMessage = { type: 'state'; x: number; y: number; angle: number; seq: number };
export type MediaMessage = { type: 'media'; cam: boolean; mic: boolean };
export type HeldMessage = { type: 'held'; item: HeldItem | null };
export type DrinkMessage = { type: 'drink' };
export type CheersMessage = { type: 'cheers' };
export type BoomboxMessage = { type: 'boombox'; on: boolean };
/** Kicks the ball the way `angle` faces; `k` counts the sender's kicks, so it recognises its own in `object_state`. */
export type KickMessage = { type: 'kick'; angle: number; k: number };
/** Asks to flip the room's portal mode. */
export type PortalsMessage = { type: 'portals' };
export type ClientMessage =
  | JoinMessage
  | StateMessage
  | MediaMessage
  | HeldMessage
  | DrinkMessage
  | CheersMessage
  | BoomboxMessage
  | KickMessage
  | PortalsMessage;

export type ErrorCode = 'room_full' | 'invalid_room' | 'invalid_name' | 'not_joined' | 'outdated';
const ERROR_CODES: readonly ErrorCode[] = ['room_full', 'invalid_room', 'invalid_name', 'not_joined', 'outdated'];

/**
 * One peer's pose in a `peers` batch: slot, then x and y (0.01 tile), angle (0.001 rad), and age: how many ms before
 * the batch the server accepted this pose, so receivers place it on its real timeline rather than the tick's.
 */
export type PeerEntry = [slot: number, x: number, y: number, angle: number, age: number];

/** A running portal switch: its kind and how many ms ago it was pressed. */
export interface PortalSequence {
  kind: SequenceKind;
  age: number;
}

export type ServerMessage =
  | {
      type: 'welcome';
      selfId: string;
      resumeToken: string;
      color: string;
      spawn: { x: number; y: number; angle: number };
      peers: PeerInfo[];
      livekit: LiveKitAccess;
      objects: ObjectInfo[];
      portals: boolean;
      /** Present while a portal switch is running; `age` is ms since its press. */
      sequence?: PortalSequence;
    }
  | { type: 'peer_joined'; peer: PeerInfo }
  | { type: 'peer_media'; id: string; cam: boolean; mic: boolean }
  | { type: 'peer_held'; id: string; item: HeldItem | null }
  | { type: 'peer_drink'; id: string }
  | { type: 'peer_cheers'; id: string }
  | { type: 'peer_boombox'; id: string; on: boolean }
  | { type: 'peer_left'; id: string }
  | { type: 'peers'; s: PeerEntry[] }
  | { type: 'portals'; on: boolean }
  | ({ type: 'portals_sequence' } & PortalSequence)
  | {
      type: 'object_state';
      id: string;
      x: number;
      y: number;
      angle: number;
      seq: number;
      event?: ObjectEvent;
      vx?: number;
      vy?: number;
      /** On a person's kick of the ball: who kicked, and their kick counter from `kick`. */
      by?: string;
      k?: number;
    }
  | { type: 'correction'; x: number; y: number; angle: number; seq: number }
  | { type: 'error'; code: ErrorCode; message: string };
export type ObjectStateMessage = Extract<ServerMessage, { type: 'object_state' }>;

const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function isValidRoomId(v: unknown): v is string {
  return typeof v === 'string' && ROOM_ID.test(v);
}

/** Base64url (no padding) of 16 random bytes: 22 characters. */
export function newRoomId(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error('newRoomId needs exactly 16 bytes');
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) {
      out += B64URL[(n >> (18 - 6 * c)) & 63];
    }
  }
  return out;
}

const AVATAR = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const AVATAR_ID = /^[A-Za-z0-9_-]{22}$/;

/** Names a picture on the server (a hash prefix of its data URL), fetched from avatarPath(id). */
export function isAvatarId(v: unknown): v is string {
  return typeof v === 'string' && AVATAR_ID.test(v);
}

export function avatarPath(id: string): string {
  return `/avatar/${id}`;
}

/** A pose as it goes on the wire, rounded so a batch stays small. */
export function peerEntry(slot: number, x: number, y: number, angle: number, age: number): PeerEntry {
  return [
    slot,
    Math.round(x * 100) / 100,
    Math.round(y * 100) / 100,
    Math.round(angle * 1000) / 1000,
    Math.max(0, Math.round(age)),
  ];
}

/** A JPEG data URL of at most AVATAR_MAX_CHARS. Receivers only ever draw it onto a canvas. */
export function isValidAvatar(v: unknown): v is string {
  return typeof v === 'string' && v.length <= AVATAR_MAX_CHARS && AVATAR.test(v);
}

/** What a peer can hold beside its avatar: a drink or the lighter (lighter spec); "nothing" is null. */
export const HELD_ITEMS = ['beer', 'coffee', 'wine', 'lighter'] as const;
export type HeldItem = (typeof HELD_ITEMS)[number];
/** A held item that can be sipped and raised in a cheers. */
export type Drink = Exclude<HeldItem, 'lighter'>;

/** One sip of the held drink lasts this long (held items spec §2.3). */
export const SIP_MS = 1400;
/** A cheers (the held drink raised) lasts this long (held items spec §2.4). */
export const CHEERS_MS = 1600;
/**
 * The server relays at most one gesture (sip or cheers) per peer per this gap: shorter than a sip, so network jitter
 * can't drop an honest one.
 */
export const DRINK_GAP_MS = 1000;

export function isHeldItem(v: unknown): v is HeldItem {
  return HELD_ITEMS.includes(v as HeldItem);
}

export function isDrink(item: HeldItem | null): item is Drink {
  return item !== null && item !== 'lighter';
}

const isControl = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0;
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
};

export function sanitizeName(v: unknown): string | null {
  if (typeof v !== 'string') {
    return null;
  }
  const name = [...v]
    .filter((ch) => !isControl(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const length = [...name].length;
  return length >= 1 && length <= NAME_MAX_CHARS ? name : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isSeq = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);

function liveKitAccess(v: unknown): LiveKitAccess | null {
  return isObj(v) && isStr(v.url) && v.url.length > 0 && isStr(v.token) && v.token.length > 0
    ? { url: v.url, token: v.token }
    : null;
}

function isPeerEntry(v: unknown): v is PeerEntry {
  return Array.isArray(v) && v.length === 5 && isSeq(v[0]) && isNum(v[1]) && isNum(v[2]) && isNum(v[3]) && isSeq(v[4]);
}

function parseJson(raw: string, limit: number): Obj | null {
  if (raw.length > limit) {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) && isStr(v.type) ? v : null;
  } catch {
    return null;
  }
}

function pose(m: Obj): { x: number; y: number; angle: number } | null {
  return isNum(m.x) && isNum(m.y) && isNum(m.angle) ? { x: m.x, y: m.y, angle: m.angle } : null;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  const m = parseJson(raw, MAX_MESSAGE_BYTES);
  if (!m) {
    return null;
  }
  if (m.type === 'join') {
    const name = sanitizeName(m.name);
    if (!isValidRoomId(m.roomId) || name === null) {
      return null;
    }
    const join: JoinMessage = { type: 'join', roomId: m.roomId, name };
    if (m.resumeToken !== undefined) {
      if (!isStr(m.resumeToken) || m.resumeToken.length > 64) {
        return null;
      }
      join.resumeToken = m.resumeToken;
    }
    // A bad picture is not worth refusing the join over: the peer just shows initials.
    if (isValidAvatar(m.avatar)) {
      join.avatar = m.avatar;
    }
    if (Number.isInteger(m.bots) && (m.bots as number) >= 1 && (m.bots as number) <= MAX_BOTS) {
      join.bots = m.bots as number;
    }
    if (Number.isInteger(m.v) && (m.v as number) >= 1) {
      join.v = m.v as number;
    }
    return join;
  }
  if (m.type === 'state') {
    const p = pose(m);
    return p && isSeq(m.seq) ? { type: 'state', ...p, seq: m.seq } : null;
  }
  if (m.type === 'media') {
    return isBool(m.cam) && isBool(m.mic) ? { type: 'media', cam: m.cam, mic: m.mic } : null;
  }
  if (m.type === 'held') {
    return m.item === null || isHeldItem(m.item) ? { type: 'held', item: m.item } : null;
  }
  if (m.type === 'drink') {
    return { type: 'drink' };
  }
  if (m.type === 'cheers') {
    return { type: 'cheers' };
  }
  if (m.type === 'boombox') {
    return isBool(m.on) ? { type: 'boombox', on: m.on } : null;
  }
  if (m.type === 'portals') {
    return { type: 'portals' };
  }
  if (m.type === 'kick') {
    return isNum(m.angle) && isSeq(m.k) ? { type: 'kick', angle: m.angle, k: m.k } : null;
  }
  return null;
}

/** Validates a PeerInfo from the wire or a snapshot; missing newer fields read as their defaults. */
export function parsePeerInfo(v: unknown): PeerInfo | null {
  if (!isObj(v) || !isStr(v.id) || !isSeq(v.slot) || !isStr(v.name) || !isStr(v.color)) {
    return null;
  }
  if (!isBool(v.cam) || !isBool(v.mic)) {
    return null;
  }
  // A missing avatar (a server from before avatars) is no avatar, so mixed versions still connect.
  if (v.avatar !== undefined && !isStrOrNull(v.avatar)) {
    return null;
  }
  const p = pose(v);
  const avatar = isAvatarId(v.avatar) ? v.avatar : null;
  // Missing (older server) or unknown (newer server's item) means empty-handed.
  const held = isHeldItem(v.held) ? v.held : null;
  // Missing (older server) or malformed reads as off: it only decides whether a sprite is drawn.
  const boombox = v.boombox === true;
  return (
    p && { id: v.id, slot: v.slot, name: v.name, color: v.color, ...p, cam: v.cam, mic: v.mic, avatar, held, boombox }
  );
}

/** Validates an object from a welcome; an unknown kind (a newer server's) reads as null. */
export function parseObjectInfo(v: unknown): ObjectInfo | null {
  if (!isObj(v) || !isStr(v.id) || !OBJECT_KINDS.includes(v.kind as ObjectKind)) {
    return null;
  }
  const p = pose(v);
  return p && { id: v.id, kind: v.kind as ObjectKind, ...p, ...velocity(v) };
}

/** A ball's velocity, kept only when both parts are numbers. */
function velocity(m: Obj): { vx: number; vy: number } | Record<string, never> {
  return isNum(m.vx) && isNum(m.vy) ? { vx: m.vx, vy: m.vy } : {};
}

const SEQUENCE_KINDS: readonly SequenceKind[] = ['first_on', 'on', 'off'];

/** Validates a kind and an age; anything else (including a newer server's kind) reads as null. */
function portalSequence(v: unknown): PortalSequence | null {
  if (!isObj(v) || !SEQUENCE_KINDS.includes(v.kind as SequenceKind) || !isNum(v.age) || v.age < 0) {
    return null;
  }
  return { kind: v.kind as SequenceKind, age: v.age };
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const m = parseJson(raw, MAX_SERVER_MESSAGE_BYTES);
  if (!m) {
    return null;
  }
  switch (m.type) {
    case 'welcome': {
      const spawn = isObj(m.spawn) ? pose(m.spawn) : null;
      if (!isStr(m.selfId) || !isStr(m.resumeToken) || !isStr(m.color) || !spawn || !Array.isArray(m.peers)) {
        return null;
      }
      const livekit = liveKitAccess(m.livekit);
      const peers = m.peers.map(parsePeerInfo);
      const sequence = portalSequence(m.sequence);
      if (!livekit || peers.some((p) => p === null)) {
        return null;
      }
      return {
        type: 'welcome',
        selfId: m.selfId,
        resumeToken: m.resumeToken,
        color: m.color,
        spawn,
        peers: peers as PeerInfo[],
        livekit,
        // Missing from an older server: no objects. Ones this client doesn't know are left out.
        objects: Array.isArray(m.objects)
          ? m.objects.map(parseObjectInfo).filter((o): o is ObjectInfo => o !== null)
          : [],
        // Missing from an older server: the portals are off.
        portals: m.portals === true,
        ...(sequence ? { sequence } : {}),
      };
    }
    case 'peer_joined': {
      const peer = parsePeerInfo(m.peer);
      return peer && { type: 'peer_joined', peer };
    }
    case 'peer_media':
      return isStr(m.id) && isBool(m.cam) && isBool(m.mic)
        ? { type: 'peer_media', id: m.id, cam: m.cam, mic: m.mic }
        : null;
    case 'peer_held':
      return isStr(m.id) ? { type: 'peer_held', id: m.id, item: isHeldItem(m.item) ? m.item : null } : null;
    case 'peer_drink':
      return isStr(m.id) ? { type: 'peer_drink', id: m.id } : null;
    case 'peer_cheers':
      return isStr(m.id) ? { type: 'peer_cheers', id: m.id } : null;
    case 'peer_boombox':
      return isStr(m.id) ? { type: 'peer_boombox', id: m.id, on: m.on === true } : null;
    case 'peer_left':
      return isStr(m.id) ? { type: 'peer_left', id: m.id } : null;
    case 'peers':
      // A bad entry costs only that peer one update: keep the rest.
      return Array.isArray(m.s) ? { type: 'peers', s: m.s.filter(isPeerEntry) } : null;
    case 'portals':
      return isBool(m.on) ? { type: 'portals', on: m.on } : null;
    case 'portals_sequence': {
      const sequence = portalSequence(m);
      return sequence && { type: 'portals_sequence', ...sequence };
    }
    case 'object_state': {
      const p = pose(m);
      if (!p || !isStr(m.id) || !isSeq(m.seq)) {
        return null;
      }
      const event = OBJECT_EVENTS.includes(m.event as ObjectEvent) ? { event: m.event as ObjectEvent } : {};
      const echo = isStr(m.by) && isSeq(m.k) ? { by: m.by, k: m.k } : {};
      return { type: 'object_state', id: m.id, ...p, seq: m.seq, ...event, ...velocity(m), ...echo };
    }
    case 'correction': {
      const p = pose(m);
      return p && isSeq(m.seq) ? { type: 'correction', ...p, seq: m.seq } : null;
    }
    case 'error':
      return ERROR_CODES.includes(m.code as ErrorCode) && isStr(m.message)
        ? { type: 'error', code: m.code as ErrorCode, message: m.message }
        : null;
    default:
      return null;
  }
}
