// Multiplayer wire protocol: message types, constants and strict validators.

export const MAX_PEERS = 8;
export const NAME_MAX = 24;
/** Client → server. A join carrying a full-size avatar is ≈ 12 KB. */
export const MAX_MESSAGE_BYTES = 16384;
/** Server → client: a welcome listing 7 avatars is ≈ 85 KB. */
export const MAX_SERVER_MESSAGE_BYTES = 131072;
export const AVATAR_SIZE = 128;
export const AVATAR_MAX_CHARS = 12_000;
export const RESUME_GRACE_MS = 30000;
export const STATE_INTERVAL_MS = 66;
export const IDLE_INTERVAL_MS = 1000;
export const INTERP_DELAY_MS = 100;
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
  name: string;
  color: string;
  x: number;
  y: number;
  angle: number;
  cam: boolean;
  mic: boolean;
  /** JPEG data URL (see isValidAvatar), shown while the camera is off. */
  avatar: string | null;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export const MAX_SDP_CHARS = 12000;
export const MAX_CANDIDATE_CHARS = 1024;

export type SignalPayload =
  | { kind: 'description'; description: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp: string } }
  | {
      kind: 'candidate';
      candidate: {
        candidate: string;
        sdpMid: string | null;
        sdpMLineIndex: number | null;
        usernameFragment: string | null;
      } | null;
    };

export type JoinMessage = {
  type: 'join';
  roomId: string;
  name: string;
  resumeToken?: string;
  avatar?: string;
};
export type StateMessage = { type: 'state'; x: number; y: number; angle: number; seq: number };
export type MediaMessage = { type: 'media'; cam: boolean; mic: boolean };
export type SignalMessage = { type: 'signal'; to: string; payload: SignalPayload };
export type ClientMessage = JoinMessage | StateMessage | MediaMessage | SignalMessage;

export type ErrorCode = 'room_full' | 'invalid_room' | 'invalid_name' | 'not_joined';
const ERROR_CODES: readonly ErrorCode[] = ['room_full', 'invalid_room', 'invalid_name', 'not_joined'];

export type ServerMessage =
  | {
      type: 'welcome';
      selfId: string;
      resumeToken: string;
      color: string;
      spawn: { x: number; y: number; angle: number };
      peers: PeerInfo[];
      iceServers: IceServer[];
    }
  | { type: 'peer_joined'; peer: PeerInfo }
  | { type: 'peer_media'; id: string; cam: boolean; mic: boolean }
  | { type: 'signal'; from: string; payload: SignalPayload }
  | { type: 'peer_left'; id: string }
  | { type: 'peer_state'; id: string; x: number; y: number; angle: number; seq: number }
  | { type: 'correction'; x: number; y: number; angle: number; seq: number }
  | { type: 'error'; code: ErrorCode; message: string };

const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function isValidRoomId(v: unknown): v is string {
  return typeof v === 'string' && ROOM_ID.test(v);
}

/** Base64url (no padding) of 16 random bytes: 22 characters. */
export function newRoomId(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('newRoomId needs exactly 16 bytes');
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += B64URL[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

const AVATAR = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/** A JPEG data URL of at most AVATAR_MAX_CHARS. Receivers only ever draw it onto a canvas. */
export function isValidAvatar(v: unknown): v is string {
  return typeof v === 'string' && v.length <= AVATAR_MAX_CHARS && AVATAR.test(v);
}

const isControl = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0;
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
};

export function sanitizeName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = [...v]
    .filter((ch) => !isControl(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const length = [...name].length;
  return length >= 1 && length <= NAME_MAX ? name : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isSeq = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const DESCRIPTION_TYPES = ['offer', 'answer', 'pranswer', 'rollback'] as const;

export function parseSignalPayload(v: unknown): SignalPayload | null {
  if (!isObj(v)) return null;
  if (v.kind === 'description') {
    const d = v.description;
    if (!isObj(d) || !DESCRIPTION_TYPES.includes(d.type as never) || !isStr(d.sdp)) return null;
    if (d.sdp.length > MAX_SDP_CHARS) return null;
    return {
      kind: 'description',
      description: { type: d.type as (typeof DESCRIPTION_TYPES)[number], sdp: d.sdp },
    };
  }
  if (v.kind === 'candidate') {
    const c = v.candidate;
    if (c === null) return { kind: 'candidate', candidate: null };
    if (!isObj(c) || !isStr(c.candidate) || c.candidate.length > MAX_CANDIDATE_CHARS) return null;
    if (!isStrOrNull(c.sdpMid) || !isStrOrNull(c.usernameFragment)) return null;
    if (c.sdpMLineIndex !== null && !isSeq(c.sdpMLineIndex)) return null;
    return {
      kind: 'candidate',
      candidate: {
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex as number | null,
        usernameFragment: c.usernameFragment,
      },
    };
  }
  return null;
}

function iceServer(v: unknown): IceServer | null {
  if (!isObj(v) || !Array.isArray(v.urls) || !v.urls.every(isStr)) return null;
  const out: IceServer = { urls: [...v.urls] };
  if (v.username !== undefined) {
    if (!isStr(v.username)) return null;
    out.username = v.username;
  }
  if (v.credential !== undefined) {
    if (!isStr(v.credential)) return null;
    out.credential = v.credential;
  }
  return out;
}

function parseJson(raw: string, limit: number): Obj | null {
  if (raw.length > limit) return null;
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
  if (!m) return null;
  if (m.type === 'join') {
    const name = sanitizeName(m.name);
    if (!isValidRoomId(m.roomId) || name === null) return null;
    const join: JoinMessage = { type: 'join', roomId: m.roomId, name };
    if (m.resumeToken !== undefined) {
      if (!isStr(m.resumeToken) || m.resumeToken.length > 64) return null;
      join.resumeToken = m.resumeToken;
    }
    // A bad picture is not worth refusing the join over: the peer just shows initials.
    if (isValidAvatar(m.avatar)) join.avatar = m.avatar;
    return join;
  }
  if (m.type === 'state') {
    const p = pose(m);
    return p && isSeq(m.seq) ? { type: 'state', ...p, seq: m.seq } : null;
  }
  if (m.type === 'media') {
    return isBool(m.cam) && isBool(m.mic) ? { type: 'media', cam: m.cam, mic: m.mic } : null;
  }
  if (m.type === 'signal') {
    const payload = parseSignalPayload(m.payload);
    return payload && isStr(m.to) ? { type: 'signal', to: m.to, payload } : null;
  }
  return null;
}

function peerInfo(v: unknown): PeerInfo | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.name) || !isStr(v.color)) return null;
  if (!isBool(v.cam) || !isBool(v.mic) || !isStrOrNull(v.avatar)) return null;
  const p = pose(v);
  const avatar = isValidAvatar(v.avatar) ? v.avatar : null;
  return p && { id: v.id, name: v.name, color: v.color, ...p, cam: v.cam, mic: v.mic, avatar };
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const m = parseJson(raw, MAX_SERVER_MESSAGE_BYTES);
  if (!m) return null;
  switch (m.type) {
    case 'welcome': {
      const spawn = isObj(m.spawn) ? pose(m.spawn) : null;
      if (!isStr(m.selfId) || !isStr(m.resumeToken) || !isStr(m.color) || !spawn || !Array.isArray(m.peers)) {
        return null;
      }
      if (!Array.isArray(m.iceServers)) return null;
      const peers = m.peers.map(peerInfo);
      const iceServers = m.iceServers.map(iceServer);
      if (peers.some((p) => p === null) || iceServers.some((i) => i === null)) return null;
      return {
        type: 'welcome',
        selfId: m.selfId,
        resumeToken: m.resumeToken,
        color: m.color,
        spawn,
        peers: peers as PeerInfo[],
        iceServers: iceServers as IceServer[],
      };
    }
    case 'peer_joined': {
      const peer = peerInfo(m.peer);
      return peer && { type: 'peer_joined', peer };
    }
    case 'peer_media':
      return isStr(m.id) && isBool(m.cam) && isBool(m.mic)
        ? { type: 'peer_media', id: m.id, cam: m.cam, mic: m.mic }
        : null;
    case 'signal': {
      const payload = parseSignalPayload(m.payload);
      return payload && isStr(m.from) ? { type: 'signal', from: m.from, payload } : null;
    }
    case 'peer_left':
      return isStr(m.id) ? { type: 'peer_left', id: m.id } : null;
    case 'peer_state': {
      const p = pose(m);
      return p && isStr(m.id) && isSeq(m.seq) ? { type: 'peer_state', id: m.id, ...p, seq: m.seq } : null;
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
