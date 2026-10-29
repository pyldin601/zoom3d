import { type SequenceKind, sequenceTimes } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { createPortalSequence, type SequenceCues } from './portal-sequence';

const START = 10_000;
const cues: SequenceCues = { countdown: false, lightsOff: false, portalsOn: false, lightsOn: false };

/** The room's portals flag before a sequence of `kind`, and after its bend. */
const flagBefore = (kind: SequenceKind) => kind === 'off';
const flagAfter = (kind: SequenceKind) => kind !== 'off';

/**
 * Steps the player every 16 ms from `fromMs` to `toMs` after the press and lists the cues by when they came. The
 * bend's `portals` message lands `bendLandsAtMs` after the press (at the bend itself by default).
 */
function play(kind: SequenceKind, fromMs: number, toMs: number, bendLandsAtMs = sequenceTimes(kind).bendAtMs) {
  const player = createPortalSequence();
  const seq = { kind, startedAt: START };
  const heard: [keyof SequenceCues, number][] = [];
  const darkAt: boolean[] = [];
  for (let age = fromMs; age <= toMs; age += 16) {
    player.update(seq, START + age, age >= bendLandsAtMs ? flagAfter(kind) : flagBefore(kind));
    darkAt.push(player.dark);
    player.takeCues(cues);
    for (const cue of ['countdown', 'lightsOff', 'portalsOn', 'lightsOn'] as const) {
      if (cues[cue]) {
        heard.push([cue, age]);
      }
    }
  }
  /** The first age, on the 16 ms grid, at which it was light again after the dark. */
  const lightAgainAt = fromMs + 16 * darkAt.findIndex((dark, i) => i > 0 && !dark && darkAt.at(i - 1) === true);
  return { player, heard, lightAgainAt };
}

test('with no sequence it is light, without a countdown or cues', () => {
  const player = createPortalSequence();
  player.update(null, START, false);
  player.takeCues(cues);
  expect(player.dark).toBe(false);
  expect(player.countdown).toBeNull();
  expect(cues).toEqual({ countdown: false, lightsOff: false, portalsOn: false, lightsOn: false });
});

test('a first_on counts down 3, 2, 1 before the dark', () => {
  const player = createPortalSequence();
  const seq = { kind: 'first_on' as const, startedAt: START };
  const seen = [0, 1000, 2000, 3000].map((age) => {
    player.update(seq, START + age, false);
    return [player.countdown, player.dark];
  });
  expect(seen).toEqual([
    [3, false],
    [2, false],
    [1, false],
    [null, true],
  ]);
});

test('a welcome mid-sequence starts dark and skips sounds whose moment has passed', () => {
  const player = createPortalSequence();
  player.update({ kind: 'first_on', startedAt: START }, START + 4000, false);
  player.takeCues(cues);
  expect(player.dark).toBe(true);
  expect(player.countdown).toBeNull();
  expect(cues.lightsOff).toBe(false);
});

test('a live first_on reports lightsOff at 3000, portalsOn at 5000 and lightsOn at 7000, each once', () => {
  const { heard } = play('first_on', 0, 9000);
  expect(heard.filter(([cue]) => cue !== 'countdown').map(([cue]) => cue)).toEqual([
    'lightsOff',
    'portalsOn',
    'lightsOn',
  ]);
  const at = Object.fromEntries(heard);
  expect(at.lightsOff).toBeGreaterThanOrEqual(3000);
  expect(at.lightsOff).toBeLessThan(3016);
  expect(at.portalsOn).toBeGreaterThanOrEqual(5000);
  expect(at.portalsOn).toBeLessThan(5016);
  expect(at.lightsOn).toBeGreaterThanOrEqual(7000);
  expect(at.lightsOn).toBeLessThan(7016);
});

test('first_on pulses once as each countdown number shows; on and off have no countdown', () => {
  const pulses = (kind: SequenceKind) => play(kind, 0, 7000).heard.filter(([cue]) => cue === 'countdown');
  expect(pulses('first_on').map(([, age]) => age)).toEqual([0, 1008, 2000]);
  expect(pulses('on')).toEqual([]);
  expect(pulses('off')).toEqual([]);
});

test('joining mid-countdown skips a number that is over 300 ms old', () => {
  const pulses = play('first_on', 1500, 3000).heard.filter(([cue]) => cue === 'countdown');
  expect(pulses).toHaveLength(1);
  const age = pulses.at(0)?.[1] ?? 0;
  expect(age).toBeGreaterThanOrEqual(2000);
  expect(age).toBeLessThan(2016);
});

test('on reports lightsOff, portalsOn and lightsOn', () => {
  expect(play('on', 0, 2000).heard.map(([cue]) => cue)).toEqual(['lightsOff', 'portalsOn', 'lightsOn']);
});

test('off reports lightsOff and lightsOn only', () => {
  expect(play('off', 0, 2000).heard.map(([cue]) => cue)).toEqual(['lightsOff', 'lightsOn']);
});

test('a hidden-tab jump of 2 s past a cue skips it', () => {
  const player = createPortalSequence();
  const seq = { kind: 'first_on' as const, startedAt: START };
  player.update(seq, START + 4000, false);
  player.takeCues(cues);
  player.update(seq, START + 7000 + 2000, true);
  player.takeCues(cues);
  expect(cues).toEqual({ countdown: false, lightsOff: false, portalsOn: false, lightsOn: false });
});

test('a cue up to 300 ms late still plays', () => {
  const player = createPortalSequence();
  const seq = { kind: 'first_on' as const, startedAt: START };
  player.update(seq, START + 4900, false);
  player.update(seq, START + 5300, true);
  player.takeCues(cues);
  expect(cues.portalsOn).toBe(true);
});

test('after the end it is light, with no cues', () => {
  const { player } = play('first_on', 0, 7100);
  player.update({ kind: 'first_on', startedAt: START }, START + 8000, true);
  player.takeCues(cues);
  expect(player.dark).toBe(false);
  expect(player.countdown).toBeNull();
  expect(cues).toEqual({ countdown: false, lightsOff: false, portalsOn: false, lightsOn: false });
});

test('a start stamped in the future through clock skew reads as the press itself', () => {
  const player = createPortalSequence();
  player.update({ kind: 'first_on', startedAt: START + 50 }, START, false);
  expect(player.countdown).toBe(3);
});

test('a new sequence plays its cues even right after another', () => {
  const player = createPortalSequence();
  player.update({ kind: 'off', startedAt: START }, START + 2000, false);
  player.takeCues(cues);
  player.update({ kind: 'on', startedAt: START + 2000 }, START + 2000, false);
  player.takeCues(cues);
  expect(cues.lightsOff).toBe(true);
});

describe('the dark waits for the bend', () => {
  test('with the bend on time, the lamps return at lightsAtMs, as the timeline says', () => {
    const { heard, lightAgainAt } = play('on', 0, 2000);
    expect(lightAgainAt).toBe(1008);
    expect(Object.fromEntries(heard).lightsOn).toBe(1008);
  });

  test('a late bend message holds the dark past lightsAtMs until the flag flips, and lights on comes then', () => {
    const { heard, lightAgainAt } = play('on', 0, 3000, 1400);
    expect(lightAgainAt).toBe(1408);
    expect(Object.fromEntries(heard).lightsOn).toBe(1408);
  });

  test('a late switch-off holds the dark the same way', () => {
    expect(play('off', 0, 3000, 1400).lightAgainAt).toBe(1408);
  });

  test('a bend that never comes ends the dark 2 s past lightsAtMs', () => {
    const { heard, lightAgainAt } = play('first_on', 0, 12_000, Number.POSITIVE_INFINITY);
    expect(lightAgainAt).toBe(9008);
    expect(Object.fromEntries(heard).lightsOn).toBe(9008);
  });

  test('a stalled tab gets the press and the bend at once: it goes straight to the bend, never counting down', () => {
    const player = createPortalSequence();
    const seq = { kind: 'first_on' as const, startedAt: START };
    player.update(seq, START, true);
    player.takeCues(cues);
    expect(player.countdown).toBeNull();
    expect(player.dark).toBe(true);
    expect(cues).toEqual({ countdown: false, lightsOff: false, portalsOn: true, lightsOn: false });
    player.update(seq, START + 1999, true);
    expect(player.dark).toBe(true);
    player.update(seq, START + 2000, true);
    player.takeCues(cues);
    expect(player.dark).toBe(false);
    expect(cues.lightsOn).toBe(true);
  });

  test('a bend landing mid-countdown ends the countdown at once', () => {
    const player = createPortalSequence();
    const seq = { kind: 'first_on' as const, startedAt: START };
    player.update(seq, START + 1000, false);
    expect(player.countdown).toBe(2);
    player.update(seq, START + 1016, true);
    expect(player.countdown).toBeNull();
    expect(player.dark).toBe(true);
  });

  test('a stalled short switch, its bend landed with the press, is never dark: bend and lights share a time', () => {
    const player = createPortalSequence();
    const seq = { kind: 'off' as const, startedAt: START };
    player.update(seq, START, false);
    expect(player.dark).toBe(false);
  });

  test('a short switch is dark until its bend lands with the lights at 1000 ms', () => {
    const player = createPortalSequence();
    const seq = { kind: 'off' as const, startedAt: START };
    player.update(seq, START, true);
    expect(player.dark).toBe(true);
    player.update(seq, START + 999, true);
    expect(player.dark).toBe(true);
    player.update(seq, START + 1000, false);
    player.takeCues(cues);
    expect(player.dark).toBe(false);
    expect(cues.lightsOn).toBe(true);
  });
});

describe('a sequence stamped again', () => {
  test('a resume welcome restamping the running sequence within 500 ms replays no cue and keeps its timing', () => {
    const player = createPortalSequence();
    player.update({ kind: 'on', startedAt: START }, START + 100, false);
    player.takeCues(cues);
    expect(cues.lightsOff).toBe(true);
    const restamped = { kind: 'on' as const, startedAt: START + 60 };
    player.update(restamped, START + 150, false);
    player.takeCues(cues);
    expect(cues).toEqual({ countdown: false, lightsOff: false, portalsOn: false, lightsOn: false });
    player.update(restamped, START + 1000, true);
    expect(player.dark).toBe(false);
  });

  test('the next switch of the same kind, a sequence later, is a new one', () => {
    const player = createPortalSequence();
    player.update({ kind: 'on', startedAt: START }, START + 100, false);
    player.takeCues(cues);
    player.update({ kind: 'on', startedAt: START + 1000 }, START + 1000, false);
    player.takeCues(cues);
    expect(cues.lightsOff).toBe(true);
  });
});
