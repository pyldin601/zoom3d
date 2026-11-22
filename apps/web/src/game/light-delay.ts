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
/** Each step moves the drawn time to the light time of the pose sampled before; three settle at walking speeds. */
const LIGHT_STEPS = 3;

const image: Apparent = { x: 0, y: 0, sees: false, through: 0, cos: 1, sin: 0 };

/**
 * Samples `out` where the thing was when the light reaching the eye now left it, starting from `drawnAt` (ms, the time
 * it would be drawn at with instant light), and returns that time; NaN when the buffer is empty. Allocation-free.
 */
export function seenAt(
  buffer: Pick<SnapshotBuffer, 'sample'>,
  light: SeenLight,
  drawnAt: number,
  out: PlayerState
): number {
  let t = drawnAt;
  for (let step = 0; step < LIGHT_STEPS; step++) {
    if (!buffer.sample(t, out)) {
      return Number.NaN;
    }
    apparentPosition(light.map, light.portals, light.eye, out, image, 1);
    t = drawnAt - (Math.hypot(image.x - light.eye.x, image.y - light.eye.y) / light.lightSpeed) * 1000;
  }
  buffer.sample(t, out);
  return t;
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
