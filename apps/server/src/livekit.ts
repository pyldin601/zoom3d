// LiveKit SFU access (LiveKit spec §3): every peer gets a token for its own room, signed with the API secret.
import { AccessToken } from 'livekit-server-sdk';

export interface LiveKitConfig {
  /** Public URL handed to clients. */
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** `livekit-server --dev` values, used when the env is unset outside production. */
const DEV: LiveKitConfig = { url: 'ws://localhost:7880', apiKey: 'devkey', apiSecret: 'secret' };
const TOKEN_TTL = '6h';

export function liveKitConfigFromEnv(env: Record<string, string | undefined>): LiveKitConfig {
  const url = env.LIVEKIT_URL;
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  if (url && apiKey && apiSecret) {
    return { url, apiKey, apiSecret };
  }
  // A missing secret must fail the rollout, not silently hand out dev tokens nobody accepts.
  if (env.NODE_ENV === 'production') {
    throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required in production');
  }
  return DEV;
}

/** A token that lets `peerId` join, publish and subscribe in LiveKit room `roomId` (the zoom3d room id). */
export function liveKitTokenFor(cfg: LiveKitConfig, roomId: string, peerId: string): Promise<string> {
  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity: peerId, ttl: TOKEN_TTL });
  at.addGrant({ room: roomId, roomJoin: true, canPublish: true, canSubscribe: true });
  return at.toJwt();
}
