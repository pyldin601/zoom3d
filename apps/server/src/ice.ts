// STUN/TURN servers handed to clients. TURN uses coturn's `use-auth-secret` scheme:
// username "<expiry>:<peerId>", credential = base64(HMAC-SHA1(secret, username)).
import { createHmac } from 'node:crypto';
import type { IceServer } from '@zoom3d/shared';

export interface IceConfig {
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string | null;
  turnTtlS: number;
}

const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
const DEFAULT_TTL_S = 21600;

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function iceConfigFromEnv(env: Record<string, string | undefined>): IceConfig {
  const stun = list(env.STUN_URLS);
  const ttl = Number(env.TURN_TTL_S);
  return {
    stunUrls: stun.length > 0 ? stun : [DEFAULT_STUN],
    turnUrls: list(env.TURN_URLS),
    turnSecret: env.TURN_SECRET || null,
    turnTtlS: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_S,
  };
}

export function iceServersFor(cfg: IceConfig, peerId: string, nowMs: number): IceServer[] {
  const servers: IceServer[] = [{ urls: cfg.stunUrls }];
  if (cfg.turnUrls.length > 0 && cfg.turnSecret) {
    const username = `${Math.floor(nowMs / 1000) + cfg.turnTtlS}:${peerId}`;
    const credential = createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
    servers.push({ urls: cfg.turnUrls, username, credential });
  }
  return servers;
}
