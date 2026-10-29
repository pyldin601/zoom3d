// The client's view of the room's running portal switch (portal sequence spec §2.3): the dark, the countdown and when
// each sound is due, all read from the shared timeline on the local clock.
import { type SequenceKind, sequenceAt, sequenceTimes } from '@zoom3d/shared';

/** A sequence as the session stamped it: `startedAt` is on the local clock. */
export interface StampedSequence {
  kind: SequenceKind;
  startedAt: number;
}

/** Which sounds are due; filled by `takeCues`. */
export interface SequenceCues {
  lightsOff: boolean;
  portalsOn: boolean;
  lightsOn: boolean;
}

export interface PortalSequencePlayer {
  /** Moves to `nowMs` (the clock `startedAt` is on); allocates nothing. */
  update(seq: StampedSequence | null, nowMs: number): void;
  readonly dark: boolean;
  readonly countdown: 3 | 2 | 1 | null;
  /** Fills `out` with the cues whose moment arrived since the last take, then forgets them. */
  takeCues(out: SequenceCues): void;
}

/** A sound this late (a hidden tab, a welcome mid-sequence) would play out of step with the dark: it is skipped. */
const CUE_LATENESS_MS = 300;

export function createPortalSequence(): PortalSequencePlayer {
  let dark = false;
  let countdown: 3 | 2 | 1 | null = null;
  let kind: SequenceKind | null = null;
  let startedAt = 0;
  /** The age of the last update, so each cue is reported once; below 0 before the first, so a cue at 0 fires. */
  let lastAgeMs = -1;
  const due: SequenceCues = { lightsOff: false, portalsOn: false, lightsOn: false };

  const arrivedOnTime = (cueAtMs: number, ageMs: number) =>
    lastAgeMs < cueAtMs && cueAtMs <= ageMs && ageMs - cueAtMs <= CUE_LATENESS_MS;

  const isNew = (seq: StampedSequence) => seq.kind !== kind || seq.startedAt !== startedAt;

  return {
    update(seq, nowMs) {
      if (seq === null) {
        dark = false;
        countdown = null;
        kind = null;
        return;
      }
      if (isNew(seq)) {
        kind = seq.kind;
        startedAt = seq.startedAt;
        lastAgeMs = -1;
      }
      // A start stamped ahead of the local clock (skew between arrival and the server's age) is the press itself.
      const ageMs = Math.max(0, nowMs - seq.startedAt);
      const frame = sequenceAt(seq.kind, ageMs);
      dark = frame.dark;
      countdown = frame.countdown;
      const times = sequenceTimes(seq.kind);
      const bendsOn = seq.kind !== 'off';
      due.lightsOff ||= arrivedOnTime(times.darkAtMs, ageMs);
      due.portalsOn ||= bendsOn && arrivedOnTime(times.bendAtMs, ageMs);
      due.lightsOn ||= arrivedOnTime(times.lightsAtMs, ageMs);
      lastAgeMs = ageMs;
    },
    get dark() {
      return dark;
    },
    get countdown() {
      return countdown;
    },
    takeCues(out) {
      out.lightsOff = due.lightsOff;
      out.portalsOn = due.portalsOn;
      out.lightsOn = due.lightsOn;
      due.lightsOff = false;
      due.portalsOn = false;
      due.lightsOn = false;
    },
  };
}
