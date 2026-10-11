// LiveKit SFU access (LiveKit spec §3): every peer gets a token for its own room, signed with the API secret.
import { createHmac } from 'node:crypto';

export interface LiveKitConfig {
  /** Public URL handed to clients. */
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** `livekit-server --dev` values, used when the env is unset outside production. */
const DEV: LiveKitConfig = { url: 'ws://localhost:7880', apiKey: 'devkey', apiSecret: 'secret' };
const TOKEN_TTL_S = 6 * 3600;

export function liveKitConfigFromEnv(env: Record<string, string | undefined>): LiveKitConfig {
  const url = env.LIVEKIT_URL;
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  // A missing secret must fail the rollout, not silently hand out dev tokens nobody accepts.
  if (env.NODE_ENV === 'production' && !(url && apiKey && apiSecret)) {
    throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required in production');
  }
  return { url: url || DEV.url, apiKey: apiKey || DEV.apiKey, apiSecret: apiSecret || DEV.apiSecret };
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/**
 * LiveKit's name for a zoom3d room. The room id is the room's only key, and LiveKit logs room names, so it gets a
 * keyed hash instead (stable per room and secret). Clients never need it: their token names the room.
 */
export function liveKitRoomName(cfg: LiveKitConfig, roomId: string): string {
  return createHmac('sha256', cfg.apiSecret).update(`room:${roomId}`).digest('base64url').slice(0, 22);
}

/**
 * A token that lets `peerId` join, publish and subscribe in the LiveKit room of zoom3d room `roomId`.
 * Signed here (HS256, the claims livekit-server-sdk writes) because it must be synchronous: the lobby sends its
 * welcome inline. Tests verify it with the SDK's TokenVerifier.
 */
export function liveKitTokenFor(cfg: LiveKitConfig, roomId: string, peerId: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    iss: cfg.apiKey,
    sub: peerId,
    jti: peerId,
    nbf: now,
    exp: now + TOKEN_TTL_S,
    video: { room: liveKitRoomName(cfg, roomId), roomJoin: true, canPublish: true, canSubscribe: true },
  })}`;
  return `${body}.${createHmac('sha256', cfg.apiSecret).update(body).digest('base64url')}`;
}
