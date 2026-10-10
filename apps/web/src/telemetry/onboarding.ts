// Onboarding funnel helpers: who opened a lobby (the party's host or an invitee) and how the media request went.
import type { DeviceProblem } from '../media/devices';
import type { MediaState } from '../media/local-media';

const HOST_KEY = 'zoom3d.hostOf';

/** "Start a party" navigates to the new room in a full page load; this tab remembers it made that room. */
export function markHost(tab: Storage | null, roomId: string): void {
  try {
    tab?.setItem(HOST_KEY, roomId);
  } catch {
    // Storage full or blocked: the lobby will count as an invite.
  }
}

export function lobbyEntry(tab: Storage | null, roomId: string): 'host' | 'invite' {
  try {
    return tab?.getItem(HOST_KEY) === roomId ? 'host' : 'invite';
  } catch {
    return 'invite';
  }
}

export type MediaOutcome = 'on' | 'off' | DeviceProblem;

/** Each device: live, off by choice (a remembered preference), or the problem that stopped it. */
export function mediaOutcome(s: MediaState): { cam: MediaOutcome; mic: MediaOutcome } {
  return { cam: s.cam ? 'on' : (s.camProblem ?? 'off'), mic: s.mic ? 'on' : (s.micProblem ?? 'off') };
}
