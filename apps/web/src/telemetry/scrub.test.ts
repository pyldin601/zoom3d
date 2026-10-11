import { expect, test } from 'vitest';
import { scrubRoomIds, scrubTelemetry } from './scrub';

test('room ids in links are replaced, the rest of the URL is kept', () => {
  expect(scrubRoomIds('https://zoom3d.pyldin601.xyz/r/AbC-12_xyzAbC-12_xyz00?debug')).toBe(
    'https://zoom3d.pyldin601.xyz/r/:room?debug'
  );
  expect(scrubRoomIds('/r/AbC-12_xyzAbC-12_xyz00')).toBe('/r/:room');
});

test('text without a room link is unchanged', () => {
  expect(scrubRoomIds('https://zoom3d.pyldin601.xyz/')).toBe('https://zoom3d.pyldin601.xyz/');
  expect(scrubRoomIds('TypeError: x is undefined')).toBe('TypeError: x is undefined');
});

test('scrubbing serialised JSON keeps it valid', () => {
  const event = {
    request: { url: 'https://z.xyz/r/AbC-12_xyzAbC-12_xyz00' },
    message: 'at "/r/AbC-12_xyzAbC-12_xyz00"',
  };
  expect(JSON.parse(scrubRoomIds(JSON.stringify(event)))).toEqual({
    request: { url: 'https://z.xyz/r/:room' },
    message: 'at "/r/:room"',
  });
});

test('LiveKit access tokens are redacted, in query strings and anywhere else', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwIiwidmlkZW8iOnt9fQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
  expect(scrubTelemetry(`https://lk.example/rtc/validate?access_token=${jwt}&auto_subscribe=1`)).toBe(
    'https://lk.example/rtc/validate?access_token=:token&auto_subscribe=1'
  );
  expect(scrubTelemetry(`token ${jwt} rejected`)).toBe('token :token rejected');
  const event = {
    breadcrumbs: [{ data: { url: `wss://lk/rtc?access_token=${jwt}` } }],
    url: '/r/AbC-12_xyzAbC-12_xyz00',
  };
  expect(JSON.parse(scrubTelemetry(JSON.stringify(event)))).toEqual({
    breadcrumbs: [{ data: { url: 'wss://lk/rtc?access_token=:token' } }],
    url: '/r/:room',
  });
});
