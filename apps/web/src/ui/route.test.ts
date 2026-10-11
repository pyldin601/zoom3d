import { expect, test } from 'vitest';
import { botsParam, parseRoute } from './route';

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

test.each([
  ['?bots=100', 100],
  ['?bots=1', 1],
  ['?debug&bots=20', 20],
  ['', null],
  ['?bots=0', null],
  ['?bots=101', null],
  ['?bots=2.5', null],
  ['?bots=abc', null],
])('botsParam(%s) → %s (opt-in bots for testing large rooms)', (search, expected) => {
  expect(botsParam(search)).toBe(expected);
});
