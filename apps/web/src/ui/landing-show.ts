// The landing page's little film (landing vacuum spec §2): the room's own robot vacuum, parked out of view, comes out
// after 10 s, cleans the corridor round Max, Ada, Bob and the camera, then searches for its dock forever. Pure and the
// same for everyone: a fixed parking pose, seed and step. Show time only moves on rendered frames, so a hidden tab
// pauses it, and nothing the visitor does reaches it.
import {
  createVacuumNav,
  FANOUT_TICK_MS,
  type PlayerState,
  type Point,
  parkVacuum,
  SnapshotBuffer,
  seeded,
  stepVacuum,
  type Vacuum,
} from '@zoom3d/shared';
import { LANDING_CAMERA, LANDING_MAP, LANDING_PEOPLE } from './landing-scene';

/** Seconds of show time before the vacuum sets off. */
export const LANDING_SHOW_WAIT_S = 10;
/** The corridor's north-west corner, beside the camera: out of view of both landing cameras at any heading. */
export const LANDING_PARK: Readonly<PlayerState> = { x: 1.5, y: 3.5, angle: 0 };
/** The most show time one frame can add: a tab back from the background resumes instead of jumping ahead. */
export const MAX_FRAME_S = 0.25;
export const LANDING_SHOW_SEED = 7;
/** The sim steps at the room's world tick, whatever the frame rate. */
const STEP_S = FANOUT_TICK_MS / 1000;

export interface LandingShow {
  /** Seconds of show time so far. */
  readonly timeS: number;
  /** The simulated robot; read it, don't change it. */
  readonly vacuum: Readonly<Vacuum>;
  /** Bumps so far. */
  readonly bumps: number;
  /** Adds one frame's time, clamped to MAX_FRAME_S, then runs any whole steps due after the wait. */
  advance(frameS: number): void;
  /** Writes the pose to draw now: LANDING_PARK before the wait ends, else interpolated between the last two steps. */
  poseInto(out: { x: number; y: number; angle: number }): void;
}

export function createLandingShow(): LandingShow {
  const nav = createVacuumNav(LANDING_MAP);
  const vacuum = parkVacuum('landing', LANDING_PARK.x, LANDING_PARK.y, LANDING_PARK.angle);
  const rng = seeded(LANDING_SHOW_SEED);
  // The camera is a person too (spec §2.3): one fixed point for both cameras, so the run is the same everywhere.
  const people: readonly Point[] = [
    ...LANDING_PEOPLE.map(({ x, y }) => ({ x, y })),
    { x: LANDING_CAMERA.x, y: LANDING_CAMERA.y },
  ];
  const poses = new SnapshotBuffer(4);
  const snap = { t: LANDING_SHOW_WAIT_S, x: vacuum.x, y: vacuum.y, angle: vacuum.angle };
  poses.push(snap);
  let timeS = 0;
  let bumps = 0;
  let steps = 0;

  return {
    get timeS() {
      return timeS;
    },
    vacuum,
    get bumps() {
      return bumps;
    },
    advance(frameS) {
      timeS += Math.max(0, Math.min(frameS, MAX_FRAME_S));
      while (LANDING_SHOW_WAIT_S + (steps + 1) * STEP_S <= timeS) {
        if (stepVacuum(nav, vacuum, STEP_S, rng, people) === 'bump') {
          bumps++;
        }
        steps++;
        snap.t = LANDING_SHOW_WAIT_S + steps * STEP_S;
        snap.x = vacuum.x;
        snap.y = vacuum.y;
        snap.angle = vacuum.angle;
        poses.push(snap);
      }
    },
    poseInto(out) {
      // One step behind, so there is always a step to interpolate towards.
      poses.sample(timeS - STEP_S, out);
    },
  };
}
