import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { iceConfigFromEnv, iceServersFor } from './ice';

test('defaults to a public STUN server only', () => {
  expect(iceServersFor(iceConfigFromEnv({}), 'p1', 0)).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
});

test('issues short-lived TURN credentials with the coturn shared-secret scheme', () => {
  const cfg = iceConfigFromEnv({
    STUN_URLS: 'stun:a:3478',
    TURN_URLS: 'turn:a:3478, turns:a:5349',
    TURN_SECRET: 's',
    TURN_TTL_S: '60',
  });
  const servers = iceServersFor(cfg, 'p1', 1_000_000);
  expect(servers).toEqual([
    { urls: ['stun:a:3478'] },
    {
      urls: ['turn:a:3478', 'turns:a:5349'],
      username: '1060:p1',
      credential: createHmac('sha1', 's').update('1060:p1').digest('base64'),
    },
  ]);
});

test('omits TURN without a secret', () => {
  const servers = iceServersFor(iceConfigFromEnv({ TURN_URLS: 'turn:a:3478' }), 'p1', 0);
  expect(servers).toHaveLength(1);
});
