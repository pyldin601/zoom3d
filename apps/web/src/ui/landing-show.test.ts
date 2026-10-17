import { describe, expect, test } from 'vitest';
import { LANDING_CAMERA, LANDING_CAMERA_PORTRAIT } from './landing-scene';
import { createLandingShow, LANDING_PARK, type LandingShow, MAX_FRAME_S } from './landing-show';

// Landing vacuum spec §2: parked out of view for 10 s, then cleans the corridor, then searches forever.
const FRAME_S = 1 / 60;
/**
 * How close the vacuum's centre may come to where the viewer stands, in tiles. As a person there, the viewer gets
 * bumped and driven round (closest about 0.56); without that it drives straight through the camera's spot.
 */
const CLEAR_OF_VIEWER_TILES = 0.5;
/** Generous cap on a full clean (a trial run took about 9.5 min). */
const CLEAN_CAP_S = 900;

const pose = { x: 0, y: 0, angle: 0 };

/** Advances `show` by whole frames until its show time reaches `seconds`. */
function runUntil(show: LandingShow, seconds: number): void {
  while (show.timeS < seconds) {
    show.advance(FRAME_S);
  }
}

test('the vacuum stays parked for the first 10 s', () => {
  const show = createLandingShow();
  runUntil(show, 9.9);
  show.poseInto(pose);
  expect(pose).toEqual({ ...LANDING_PARK });
  expect(show.vacuum.x).toBe(LANDING_PARK.x);
  expect(show.vacuum.y).toBe(LANDING_PARK.y);
});

test('it drives off after the wait', () => {
  const show = createLandingShow();
  runUntil(show, 15);
  show.poseInto(pose);
  expect(Math.hypot(pose.x - LANDING_PARK.x, pose.y - LANDING_PARK.y)).toBeGreaterThan(0.1);
});

test('poseInto says whether the pose moved, so a still picture needs no redraw', () => {
  const show = createLandingShow();
  const out = { ...LANDING_PARK };
  runUntil(show, 5);
  expect(show.poseInto(out)).toBe(false);
  runUntil(show, 15);
  expect(show.poseInto(out)).toBe(true);
  expect(show.poseInto(out)).toBe(false);
});

test('a long frame counts as at most MAX_FRAME_S', () => {
  const show = createLandingShow();
  show.advance(300);
  expect(show.timeS).toBe(MAX_FRAME_S);
});

test('every show is the same show', () => {
  const a = createLandingShow();
  const b = createLandingShow();
  for (const at of [30, 120, 400]) {
    runUntil(a, at);
    runUntil(b, at);
    const pa = { x: 0, y: 0, angle: 0 };
    const pb = { x: 0, y: 0, angle: 0 };
    a.poseInto(pa);
    b.poseInto(pb);
    expect(pa).toEqual(pb);
  }
});

describe('a full run', () => {
  const show = createLandingShow();
  let closestToCameraTiles = Number.POSITIVE_INFINITY;
  let bumpsWhenLost = -1;
  let lostAtS = -1;
  while (show.timeS < CLEAN_CAP_S + 120) {
    show.advance(FRAME_S);
    show.poseInto(pose);
    for (const camera of [LANDING_CAMERA, LANDING_CAMERA_PORTRAIT]) {
      closestToCameraTiles = Math.min(closestToCameraTiles, Math.hypot(pose.x - camera.x, pose.y - camera.y));
    }
    if (lostAtS < 0 && show.vacuum.phase === 'searching') {
      lostAtS = show.timeS;
      bumpsWhenLost = show.bumps;
    }
  }

  test('it bumps into the people while cleaning', () => {
    expect(bumpsWhenLost).toBeGreaterThanOrEqual(1);
  });

  test('it finishes cleaning and gets lost', () => {
    expect(lostAtS).toBeGreaterThan(0);
    expect(lostAtS).toBeLessThan(CLEAN_CAP_S);
    expect(show.vacuum.phase).toBe('searching');
  });

  test('the camera is a person: the vacuum never drives through the viewer', () => {
    expect(closestToCameraTiles).toBeGreaterThan(CLEAR_OF_VIEWER_TILES);
  });
});
