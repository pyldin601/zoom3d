// Drink gestures (held items spec §2.3–2.4): a sip goes to the mouth, a cheers raises the drink with a wobble.
// Both go there, hold, and come back with eased moves, and a player plays one at a time.
import { CHEERS_MS, SIP_MS } from '@zoom3d/shared';

const MOVE_MS = 350;

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** 0 at rest, 1 while the drink is at the mouth, for `elapsedMs` since the sip started. */
export function sipPose(elapsedMs: number): number {
  if (!(elapsedMs >= 0 && elapsedMs < SIP_MS)) {
    return 0;
  }
  if (elapsedMs < MOVE_MS) {
    return easeInOut(elapsedMs / MOVE_MS);
  }
  if (elapsedMs <= SIP_MS - MOVE_MS) {
    return 1;
  }
  return easeInOut((SIP_MS - elapsedMs) / MOVE_MS);
}

const CHEERS_MOVE_MS = 300;
const WOBBLE_HZ = 2;

export interface CheersPose {
  /** 0 at rest, 1 while raised. */
  lift: number;
  /** −1..1 side to side, scaled by the lift. */
  wobble: number;
}

const cheers: CheersPose = { lift: 0, wobble: 0 };

/** The cheers pose `elapsedMs` since it started. Returns a reused object: copy it to keep it. */
export function cheersPose(elapsedMs: number): CheersPose {
  if (!(elapsedMs >= 0 && elapsedMs < CHEERS_MS)) {
    cheers.lift = 0;
    cheers.wobble = 0;
    return cheers;
  }
  if (elapsedMs < CHEERS_MOVE_MS) {
    cheers.lift = easeInOut(elapsedMs / CHEERS_MOVE_MS);
  } else if (elapsedMs <= CHEERS_MS - CHEERS_MOVE_MS) {
    cheers.lift = 1;
  } else {
    cheers.lift = easeInOut((CHEERS_MS - elapsedMs) / CHEERS_MOVE_MS);
  }
  cheers.wobble = Math.sin((2 * Math.PI * WOBBLE_HZ * (elapsedMs - CHEERS_MOVE_MS)) / 1000) * cheers.lift;
  return cheers;
}

export type Gesture = 'sip' | 'cheers';

/** What the held drink is doing: at most one of `sip` and `cheers` is above 0. */
export interface HeldPose {
  sip: number;
  cheers: number;
  wobble: number;
}

export interface GestureClock {
  /** Starts a gesture at `now` unless one is still playing; true if it started. */
  start(kind: Gesture, now: number): boolean;
  /** Ends a playing gesture at once (the drink was put down). */
  cancel(): void;
  /** The gesture playing at `now`, or null. */
  kind(now: number): Gesture | null;
  /** Returns a reused object: copy it to keep it. */
  pose(now: number): HeldPose;
}

const durationOf = (kind: Gesture) => (kind === 'sip' ? SIP_MS : CHEERS_MS);

export function createGestureClock(): GestureClock {
  let kind: Gesture = 'sip';
  let startedAt = Number.NEGATIVE_INFINITY;
  const pose: HeldPose = { sip: 0, cheers: 0, wobble: 0 };
  const playing = (now: number) => now - startedAt < durationOf(kind);
  return {
    start(next, now) {
      if (playing(now)) {
        return false;
      }
      kind = next;
      startedAt = now;
      return true;
    },
    cancel() {
      startedAt = Number.NEGATIVE_INFINITY;
    },
    kind: (now) => (playing(now) ? kind : null),
    pose(now) {
      const elapsed = now - startedAt;
      pose.sip = kind === 'sip' ? sipPose(elapsed) : 0;
      const c = kind === 'cheers' ? cheersPose(elapsed) : null;
      pose.cheers = c ? c.lift : 0;
      pose.wobble = c ? c.wobble : 0;
      return pose;
    },
  };
}
