// Onboarding funnel helper: how the lobby's first camera and mic requests went.
import type { DeviceProblem } from '../media/devices';
import type { MediaState } from '../media/local-media';

export type MediaOutcome = 'on' | 'off' | DeviceProblem;

/** Each device: live, off by choice (a remembered preference), or the problem that stopped it. */
export function mediaOutcome(s: MediaState): { cam: MediaOutcome; mic: MediaOutcome } {
  return { cam: s.cam ? 'on' : (s.camProblem ?? 'off'), mic: s.mic ? 'on' : (s.micProblem ?? 'off') };
}
