import { expect, test } from 'vitest';
import { scrubRoomIds } from './scrub';

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
