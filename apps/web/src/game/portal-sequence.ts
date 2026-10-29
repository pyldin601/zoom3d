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
  /**
   * Moves to `nowMs` (the clock `startedAt` is on); `portalsOn` is the room's portals flag as the session has it.
   * Allocates nothing.
   */
  update(seq: StampedSequence | null, nowMs: number, portalsOn: boolean): void;
  readonly dark: boolean;
  readonly countdown: 3 | 2 | 1 | null;
  /** Fills `out` with the cues whose moment arrived since the last take, then forgets them. */
  takeCues(out: SequenceCues): void;
}

/** A sound this late (a hidden tab, a welcome mid-sequence) would play out of step with the dark: it is skipped. */
const CUE_LATENESS_MS = 300;
/**
 * The bend comes in its own `portals` message, up to a tick after its moment plus the network's delay: the lamps wait
 * for it, so the space never bends in their light, but no longer than this past their time, should it never come.
 */
const BEND_WAIT_CAP_MS = 2000;
/** Before any update, an age below every moment, so a cue at 0 fires. */
const NOT_YET_MS = -1;
/**
 * Stamps of one kind this close name one sequence: a resume welcome restamps the running one from a fresh age, off by
 * no more than the network's wobble, while the next sequence starts at least one whole (1 s) later.
 */
const SAME_SEQUENCE_MS = 500;

export function createPortalSequence(): PortalSequencePlayer {
  let dark = false;
  let countdown: 3 | 2 | 1 | null = null;
  let kind: SequenceKind | null = null;
  /** The session's first stamp of the sequence, which names it. */
  let stampedAt = 0;
  /** Where this player has the start: the stamp, or later when the stamp turned out late. */
  let startedAt = 0;
  /** The age of the last update, so each cue is reported once. */
  let lastAgeMs = NOT_YET_MS;
  /** The age of the last update before the flag was seen at the sequence's target: the bend landed after it. */
  let bendLandedAfterMs = Number.POSITIVE_INFINITY;
  const due: SequenceCues = { lightsOff: false, portalsOn: false, lightsOn: false };

  const arrivedOnTime = (cueAtMs: number, ageMs: number) =>
    lastAgeMs < cueAtMs && cueAtMs <= ageMs && ageMs - cueAtMs <= CUE_LATENESS_MS;

  // A restamp keeps the first stamp: adopting the new one could step the timeline back, into the dark again.
  const isNew = (seq: StampedSequence) => seq.kind !== kind || Math.abs(seq.startedAt - stampedAt) > SAME_SEQUENCE_MS;

  const begin = (seq: StampedSequence) => {
    kind = seq.kind;
    stampedAt = seq.startedAt;
    startedAt = seq.startedAt;
    lastAgeMs = NOT_YET_MS;
    bendLandedAfterMs = Number.POSITIVE_INFINITY;
    dark = false;
  };

  return {
    update(seq, nowMs, portalsOn) {
      if (seq === null) {
        dark = false;
        countdown = null;
        kind = null;
        return;
      }
      if (isNew(seq)) {
        begin(seq);
      }
      const times = sequenceTimes(seq.kind);
      const bent = portalsOn === (seq.kind !== 'off');
      // A start stamped ahead of the local clock (skew between arrival and the server's age) is the press itself.
      let ageMs = Math.max(0, nowMs - startedAt);
      if (bent && ageMs < times.bendAtMs) {
        // The bend is never sent before its moment, so the press reached this tab late, held up with the bend (a
        // stalled tab): the sequence is at least at its bend, and it plays on from there.
        startedAt = nowMs - times.bendAtMs;
        ageMs = times.bendAtMs;
      }
      if (bent && bendLandedAfterMs === Number.POSITIVE_INFINITY) {
        bendLandedAfterMs = Math.max(0, lastAgeMs);
      }
      const lightsBackAtMs = Math.min(
        Math.max(times.lightsAtMs, bendLandedAfterMs),
        times.lightsAtMs + BEND_WAIT_CAP_MS
      );
      const wasDark = dark;
      countdown = sequenceAt(seq.kind, ageMs).countdown;
      dark = ageMs >= times.darkAtMs && ageMs < lightsBackAtMs;
      due.lightsOff ||= arrivedOnTime(times.darkAtMs, ageMs);
      due.portalsOn ||= seq.kind !== 'off' && arrivedOnTime(times.bendAtMs, ageMs);
      // Its moment is only known once it is light again: up to an update's gap after the bend landed.
      due.lightsOn ||= wasDark && !dark && ageMs - lightsBackAtMs <= CUE_LATENESS_MS;
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
