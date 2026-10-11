import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, test } from 'vitest';
import { liveKitConfigFromEnv, liveKitTokenFor } from './livekit';

describe('liveKitConfigFromEnv', () => {
  test('defaults to the LiveKit dev server outside production', () => {
    expect(liveKitConfigFromEnv({})).toEqual({ url: 'ws://localhost:7880', apiKey: 'devkey', apiSecret: 'secret' });
  });

  test('reads the three variables', () => {
    const env = { NODE_ENV: 'production', LIVEKIT_URL: 'wss://lk', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' };
    expect(liveKitConfigFromEnv(env)).toEqual({ url: 'wss://lk', apiKey: 'k', apiSecret: 's' });
  });

  test.each(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])(
    'production without %s refuses to start',
    (name) => {
      const env: Record<string, string | undefined> = {
        NODE_ENV: 'production',
        LIVEKIT_URL: 'wss://lk',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      };
      env[name] = '';
      expect(() => liveKitConfigFromEnv(env)).toThrow(/required in production/);
    }
  );
});

describe('liveKitTokenFor', () => {
  const cfg = { url: 'ws://localhost:7880', apiKey: 'devkey', apiSecret: 'a-secret-long-enough-for-hs256-signing' };

  test('signs a 6 h token that lets the peer join, publish and subscribe in its room only', async () => {
    const token = await liveKitTokenFor(cfg, 'AAAAAAAAAAAAAAAAAAAAAA', 'peer-1');
    const claims = await new TokenVerifier(cfg.apiKey, cfg.apiSecret).verify(token);
    expect(claims.sub).toBe('peer-1');
    expect(claims.video).toMatchObject({
      room: 'AAAAAAAAAAAAAAAAAAAAAA',
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(6 * 3600);
  });

  test('a token signed with another secret does not verify', async () => {
    const token = await liveKitTokenFor(cfg, 'AAAAAAAAAAAAAAAAAAAAAA', 'peer-1');
    await expect(new TokenVerifier(cfg.apiKey, 'another-secret-long-enough-for-hs256').verify(token)).rejects.toThrow();
  });
});
