// The shared timeline of a portal switch: every client and the server read the same times, counted from the press.
// Pure.

export type SequenceKind = 'first_on' | 'on' | 'off';

export interface SequenceTimes {
  darkAtMs: number;
  /** When the room's portal mode flips, hidden by the dark. */
  bendAtMs: number;
  lightsAtMs: number;
  endMs: number;
}

export interface SequenceFrame {
  countdown: 3 | 2 | 1 | null;
  dark: boolean;
  ended: boolean;
}

const COUNTDOWN_STEP_MS = 1000;
const COUNTDOWN_STEPS = 3;

const FIRST_ON_TIMES: SequenceTimes = {
  darkAtMs: COUNTDOWN_STEPS * COUNTDOWN_STEP_MS,
  bendAtMs: 5000,
  lightsAtMs: 7000,
  endMs: 7000,
};
const SHORT_TIMES: SequenceTimes = { darkAtMs: 0, bendAtMs: 500, lightsAtMs: 1000, endMs: 1000 };

export function sequenceTimes(kind: SequenceKind): SequenceTimes {
  return kind === 'first_on' ? FIRST_ON_TIMES : SHORT_TIMES;
}

const frame: SequenceFrame = { countdown: null, dark: false, ended: false };

/** What a sequence shows `ageMs` after its press. The returned object is reused: read it before the next call. */
export function sequenceAt(kind: SequenceKind, ageMs: number): SequenceFrame {
  const times = sequenceTimes(kind);
  const counting = kind === 'first_on' && ageMs < times.darkAtMs;
  frame.countdown = counting ? ((COUNTDOWN_STEPS - Math.floor(ageMs / COUNTDOWN_STEP_MS)) as 3 | 2 | 1) : null;
  frame.ended = ageMs >= times.endMs;
  frame.dark = !frame.ended && ageMs >= times.darkAtMs && ageMs < times.lightsAtMs;
  return frame;
}

export function countdownText(n: 3 | 2 | 1): string {
  return `Portals will enable in ${n}…`;
}
