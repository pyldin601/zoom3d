// Multiplayer wire protocol: message types, constants and strict validators.

export const MAX_PEERS = 8;
export const NAME_MAX = 24;
export const MAX_MESSAGE_BYTES = 16384;
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
}

export type JoinMessage = { type: 'join'; roomId: string; name: string; resumeToken?: string };
export type StateMessage = { type: 'state'; x: number; y: number; angle: number; seq: number };
export type ClientMessage = JoinMessage | StateMessage;

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
    }
  | { type: 'peer_joined'; peer: PeerInfo }
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

function parseJson(raw: string): Obj | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
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
  const m = parseJson(raw);
  if (!m) return null;
  if (m.type === 'join') {
    const name = sanitizeName(m.name);
    if (!isValidRoomId(m.roomId) || name === null) return null;
    if (m.resumeToken === undefined) return { type: 'join', roomId: m.roomId, name };
    if (!isStr(m.resumeToken) || m.resumeToken.length > 64) return null;
    return { type: 'join', roomId: m.roomId, name, resumeToken: m.resumeToken };
  }
  if (m.type === 'state') {
    const p = pose(m);
    return p && isSeq(m.seq) ? { type: 'state', ...p, seq: m.seq } : null;
  }
  return null;
}

function peerInfo(v: unknown): PeerInfo | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.name) || !isStr(v.color)) return null;
  const p = pose(v);
  return p && { id: v.id, name: v.name, color: v.color, ...p };
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const m = parseJson(raw);
  if (!m) return null;
  switch (m.type) {
    case 'welcome': {
      const spawn = isObj(m.spawn) ? pose(m.spawn) : null;
      if (!isStr(m.selfId) || !isStr(m.resumeToken) || !isStr(m.color) || !spawn || !Array.isArray(m.peers)) {
        return null;
      }
      const peers = m.peers.map(peerInfo);
      if (peers.some((p) => p === null)) return null;
      return {
        type: 'welcome',
        selfId: m.selfId,
        resumeToken: m.resumeToken,
        color: m.color,
        spawn,
        peers: peers as PeerInfo[],
      };
    }
    case 'peer_joined': {
      const peer = peerInfo(m.peer);
      return peer && { type: 'peer_joined', peer };
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
