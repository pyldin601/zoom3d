import { expect, test } from 'vitest';
import { preferPlayAndRecord } from './audio-session';

test('sets play-and-record when audioSession exists', () => {
  const nav = { audioSession: { type: 'auto' } };
  preferPlayAndRecord(nav);
  expect(nav.audioSession.type).toBe('play-and-record');
});

test('does nothing without audioSession', () => {
  expect(() => preferPlayAndRecord({})).not.toThrow();
});
