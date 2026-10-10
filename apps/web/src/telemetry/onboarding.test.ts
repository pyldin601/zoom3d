import { expect, test } from 'vitest';
import type { MediaState } from '../media/local-media';
import { mediaOutcome } from './onboarding';

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
