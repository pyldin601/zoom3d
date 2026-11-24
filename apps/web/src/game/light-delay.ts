// Slow light's delay (D39): each remote thing is drawn where it was when the light now reaching the eye left it.
import {
  type Apparent,
  apparentPosition,
  FANOUT_TICK_MS,
  type GameMap,
  type PlayerState,
  type Portals,
  SnapshotBuffer,
} from '@zoom3d/shared';

type Point = { x: number; y: number };

/** What the light delay is measured from: the room, its sight portals, the eye now and c in tiles/s. */
export interface SeenLight {
  map: GameMap;
  portals: Portals | null;
  eye: Point;
  lightSpeed: number;
}

/** Pose history kept per peer and object: at the slowest c, light crosses the room (~40 tiles) in about 7 s. */
export const HISTORY_CAPACITY = 128;
/**
 * The light time is solved to within this (ms). At the ball's top speed a thing moves 0.005 tiles in it.
 */
const SETTLED_MS = 0.5;
/**
 * The most poses a solve samples. A still thing settles in 2 and a kicked ball in about 5. Light from a thing
 * approaching faster than light can leave it at several times, and the solve keeps its best.
 */
const MAX_LOOKS = 16;

const image: Apparent = { x: 0, y: 0, sees: false, through: 0, cos: 1, sin: 0 };

/** The solve under way: the time closest to the light time so far, its miss, and how many poses it sampled. */
const solve = { best: 0, bestMiss: 0, looks: 0 };

/**
 * How much earlier than `t` the light reaching the eye at `drawnAt` would have left the pose at `t` (ms). The light
 * time is where this is zero: it is negative at a time too late and positive at one too early. Samples the pose into
 * `out` and keeps the best time in `solve`.
 */
function missAt(
  buffer: Pick<SnapshotBuffer, 'sample'>,
  light: SeenLight,
  drawnAt: number,
  t: number,
  out: PlayerState
) {
  buffer.sample(t, out);
  apparentPosition(light.map, light.portals, light.eye, out, image, 1);
  const miss = drawnAt - t - (Math.hypot(image.x - light.eye.x, image.y - light.eye.y) / light.lightSpeed) * 1000;
  solve.looks++;
  if (Math.abs(miss) < Math.abs(solve.bestMiss)) {
    solve.best = t;
    solve.bestMiss = miss;
  }
  return miss;
}

const unsettled = () => solve.looks < MAX_LOOKS && Math.abs(solve.bestMiss) >= SETTLED_MS;

/**
 * Samples `out` where the thing was when the light reaching the eye now left it, starting from `drawnAt` (ms, the time
 * it would be drawn at with instant light), and returns that time; NaN when the buffer is empty. Allocation-free.
 * The light time is bracketed and then narrowed by false position (Illinois). Plain repeated steps from `drawnAt` swing
 * past it for anything moving away at more than half of c, and a kicked ball looked stuck at its kick.
 */
export function seenAt(
  buffer: Pick<SnapshotBuffer, 'sample'>,
  light: SeenLight,
  drawnAt: number,
  out: PlayerState
): number {
  if (!buffer.sample(drawnAt, out)) {
    return Number.NaN;
  }
  solve.best = drawnAt;
  solve.bestMiss = Number.POSITIVE_INFINITY;
  solve.looks = 0;
  let late = drawnAt;
  let lateMiss = missAt(buffer, light, drawnAt, late, out);

  // Bracket: step back by the miss, doubling the step, until a time is too early.
  let early = late + lateMiss;
  let earlyMiss = missAt(buffer, light, drawnAt, early, out);
  for (let reach = 2; earlyMiss < 0 && unsettled(); reach *= 2) {
    late = early;
    lateMiss = earlyMiss;
    early = late + lateMiss * reach;
    earlyMiss = missAt(buffer, light, drawnAt, early, out);
  }

  // Narrow: when the same end moves twice running, the other end's miss is halved, so it can't stay stuck.
  let lastMoved: 'early' | 'late' | null = null;
  while (earlyMiss > 0 && unsettled()) {
    const t = early + (earlyMiss / (earlyMiss - lateMiss)) * (late - early);
    const miss = missAt(buffer, light, drawnAt, t, out);
    if (miss < 0) {
      late = t;
      lateMiss = miss;
      earlyMiss = lastMoved === 'late' ? earlyMiss / 2 : earlyMiss;
      lastMoved = 'late';
    } else {
      early = t;
      earlyMiss = miss;
      lateMiss = lastMoved === 'early' ? lateMiss / 2 : lateMiss;
      lastMoved = 'early';
    }
  }
  buffer.sample(solve.best, out);
  return solve.best;
}

/**
 * A pose history filled every frame (the ball, the local player) that holds as long as a peer's: its newest entry
 * follows the present, and becomes history once a server tick has passed since the one before it. Pushed every frame,
 * a 144 Hz screen would fill HISTORY_CAPACITY in under a second.
 */
export interface Trail {
  readonly buffer: SnapshotBuffer;
  push(t: number, x: number, y: number, angle: number): void;
}

/** A trail whose newest entry settles every `settleMs`, keeping `capacity` of them. */
export function createTrail(settleMs = FANOUT_TICK_MS, capacity = HISTORY_CAPACITY): Trail {
  const buffer = new SnapshotBuffer(capacity);
  const entry = { t: 0, x: 0, y: 0, angle: 0 };
  /** When the entry before the newest was made. */
  let settledAt = Number.NEGATIVE_INFINITY;
  return {
    buffer,
    push(t, x, y, angle) {
      const head = buffer.latest();
      if (head && t >= head.t && t - settledAt < settleMs) {
        head.t = t;
        head.x = x;
        head.y = y;
        head.angle = angle;
        return;
      }
      settledAt = head?.t ?? t;
      entry.t = t;
      entry.x = x;
      entry.y = y;
      entry.angle = angle;
      buffer.push(entry);
    },
  };
}
