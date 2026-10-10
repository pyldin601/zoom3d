import { expect, test } from 'vitest';
import type { MediaState } from '../media/local-media';
import { lobbyEntry, markHost, mediaOutcome } from './onboarding';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

test('the tab that started a party opens its lobby as host, any other room as an invitee', () => {
  const tab = memoryStorage();
  expect(lobbyEntry(tab, ROOM)).toBe('invite');
  markHost(tab, ROOM);
  expect(lobbyEntry(tab, ROOM)).toBe('host');
  expect(lobbyEntry(tab, OTHER)).toBe('invite');
});

test('without storage everyone is an invitee and nothing throws', () => {
  expect(() => markHost(null, ROOM)).not.toThrow();
  expect(lobbyEntry(null, ROOM)).toBe('invite');
});

const state = (s: Partial<MediaState>): MediaState => ({
  cam: false,
  mic: false,
  camAvailable: true,
  micAvailable: true,
  camProblem: null,
  micProblem: null,
  pending: false,
  ...s,
});

test('each device reports on, off by choice, or the problem that stopped it', () => {
  expect(mediaOutcome(state({ cam: true, mic: true }))).toEqual({ cam: 'on', mic: 'on' });
  expect(mediaOutcome(state({ mic: true }))).toEqual({ cam: 'off', mic: 'on' });
  expect(
    mediaOutcome(state({ camAvailable: false, camProblem: 'blocked', micAvailable: false, micProblem: 'missing' }))
  ).toEqual({ cam: 'blocked', mic: 'missing' });
});
