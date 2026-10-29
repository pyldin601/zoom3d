import type { SequenceKind } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { createPortalSequence, type SequenceCues } from './portal-sequence';

const START = 10_000;
const cues: SequenceCues = { lightsOff: false, portalsOn: false, lightsOn: false };

/** Steps the player every 16 ms from `fromMs` to `toMs` after the press and lists the cues by when they came. */
function play(kind: SequenceKind, fromMs: number, toMs: number) {
  const player = createPortalSequence();
  const seq = { kind, startedAt: START };
  const heard: [keyof SequenceCues, number][] = [];
  for (let age = fromMs; age <= toMs; age += 16) {
    player.update(seq, START + age);
    player.takeCues(cues);
    for (const cue of ['lightsOff', 'portalsOn', 'lightsOn'] as const) {
      if (cues[cue]) {
        heard.push([cue, age]);
      }
    }
  }
  return { player, heard };
}

test('with no sequence it is light, without a countdown or cues', () => {
  const player = createPortalSequence();
  player.update(null, START);
  player.takeCues(cues);
  expect(player.dark).toBe(false);
  expect(player.countdown).toBeNull();
  expect(cues).toEqual({ lightsOff: false, portalsOn: false, lightsOn: false });
});

test('a first_on counts down 3, 2, 1 before the dark', () => {
  const player = createPortalSequence();
  const seq = { kind: 'first_on' as const, startedAt: START };
  const seen = [0, 1000, 2000, 3000].map((age) => {
    player.update(seq, START + age);
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
  player.update({ kind: 'first_on', startedAt: START }, START + 4000);
  player.takeCues(cues);
  expect(player.dark).toBe(true);
  expect(player.countdown).toBeNull();
  expect(cues.lightsOff).toBe(false);
});

test('a live first_on reports lightsOff at 3000, portalsOn at 5000 and lightsOn at 7000, each once', () => {
  const { heard } = play('first_on', 0, 9000);
  expect(heard.map(([cue]) => cue)).toEqual(['lightsOff', 'portalsOn', 'lightsOn']);
  const at = Object.fromEntries(heard);
  expect(at.lightsOff).toBeGreaterThanOrEqual(3000);
  expect(at.lightsOff).toBeLessThan(3016);
  expect(at.portalsOn).toBeGreaterThanOrEqual(5000);
  expect(at.portalsOn).toBeLessThan(5016);
  expect(at.lightsOn).toBeGreaterThanOrEqual(7000);
  expect(at.lightsOn).toBeLessThan(7016);
});

test('on reports all three cues', () => {
  expect(play('on', 0, 2000).heard.map(([cue]) => cue)).toEqual(['lightsOff', 'portalsOn', 'lightsOn']);
});

test('off reports lightsOff and lightsOn only', () => {
  expect(play('off', 0, 2000).heard.map(([cue]) => cue)).toEqual(['lightsOff', 'lightsOn']);
});

test('a hidden-tab jump of 2 s past a cue skips it', () => {
  const player = createPortalSequence();
  const seq = { kind: 'first_on' as const, startedAt: START };
  player.update(seq, START + 4000);
  player.takeCues(cues);
  player.update(seq, START + 7000 + 2000);
  player.takeCues(cues);
  expect(cues).toEqual({ lightsOff: false, portalsOn: false, lightsOn: false });
});

test('a cue up to 300 ms late still plays', () => {
  const player = createPortalSequence();
  const seq = { kind: 'first_on' as const, startedAt: START };
  player.update(seq, START + 4900);
  player.update(seq, START + 5300);
  player.takeCues(cues);
  expect(cues.portalsOn).toBe(true);
});

test('after the end it is light, with no cues', () => {
  const { player } = play('first_on', 0, 7100);
  player.update({ kind: 'first_on', startedAt: START }, START + 8000);
  player.takeCues(cues);
  expect(player.dark).toBe(false);
  expect(player.countdown).toBeNull();
  expect(cues).toEqual({ lightsOff: false, portalsOn: false, lightsOn: false });
});

test('a start stamped in the future through clock skew reads as the press itself', () => {
  const player = createPortalSequence();
  player.update({ kind: 'first_on', startedAt: START + 50 }, START);
  expect(player.countdown).toBe(3);
});

test('a new sequence plays its cues even right after another', () => {
  const player = createPortalSequence();
  player.update({ kind: 'off', startedAt: START }, START + 2000);
  player.takeCues(cues);
  player.update({ kind: 'on', startedAt: START + 2000 }, START + 2000);
  player.takeCues(cues);
  expect(cues.lightsOff).toBe(true);
});
