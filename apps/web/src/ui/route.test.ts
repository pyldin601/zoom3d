import { expect, test } from 'vitest';
import { parseRoute } from './route';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';

test.each([
  ['/', { kind: 'landing' }],
  [`/r/${ID}`, { kind: 'room', roomId: ID }],
  [`/r/${ID}/`, { kind: 'room', roomId: ID }],
  ['/r/short', { kind: 'invalid' }],
  ['/r/', { kind: 'invalid' }],
  ['/x', { kind: 'invalid' }],
])('%s', (path, expected) => {
  expect(parseRoute(path)).toEqual(expected);
});
