// Another rider's scooter motion, read from the poses the server sent of them (scooter sound spec §4): how fast they go,
// whether the motor is pulling, holding speed or coasting, and whether they just hit a wall. Read from the snapshots,
// not the drawn positions: those freeze before a portal jump and slow while the draw delay changes tier, and frame by
// frame they wobble with the 66 ms tick grid. Speeds are averaged over a third of a second for the same reason.
import { INTERP_DELAY_MS, RIDE_SPEED, type SnapshotBuffer } from '@zoom3d/shared';
import { FAR_DELAY_MS, tierInterval } from '../net/peer-delay';
import type { ScooterLoad } from './scooter-sound';

/** Speeds are averaged over at least this long, and over two update intervals for far riders. */
const WINDOW_MS = 350;
/** Rising this much (tiles/s) between two windows is the motor pulling; falling this much is coasting. */
const PULL_RISE = 0.6;
const COAST_DROP = 0.35;
const MOVING_TILES_PER_S = 0.3;
/** A load is heard only once it has held this long, so one odd window can't flip it. */
const LOAD_HOLD_MS = 300;
/** No update for this many intervals: the server sends nothing for a rider standing still, so they stopped. */
const STALE_INTERVALS = 1.8;
/** The stop is a bump only if the last stretch before it was at least this fast (tiles/s); braking ends slower. */
const BUMP_MIN_SPEED = 1.5;
const BUMP_GAP_MS = 300;
const MIN_IMPACT = 0.15;

export interface RiderMotion {
  /** Tiles/s, as the last window of snapshots shows it. */
  speed: number;
  load: ScooterLoad;
  /** A bump found on this read: its impact (0 when none), and how many ms from now the stop is drawn. */
  bumpImpact: number;
  bumpInMs: number;
  /** The load the windows point to, and since when: it becomes `load` once held long enough. */
  pending: ScooterLoad;
  pendingSinceMs: number;
  /** The snapshot time a bump was already played for, and when. */
  bumpedForMs: number;
  lastBumpMs: number;
}

export const createRiderMotion = (): RiderMotion => ({
  speed: 0,
  load: 'coasting',
  bumpImpact: 0,
  bumpInMs: 0,
  pending: 'coasting',
  pendingSinceMs: 0,
  bumpedForMs: Number.NaN,
  lastBumpMs: Number.NEGATIVE_INFINITY,
});

/** Updates `m` from `buffer` at `nowMs`; `delayMs` is how late this rider is drawn, which tells their tier. */
export function readRiderMotion(m: RiderMotion, buffer: SnapshotBuffer, nowMs: number, delayMs: number): void {
  m.bumpImpact = 0;
  const latest = buffer.latest();
  if (!latest) {
    m.speed = 0;
    m.load = 'coasting';
    return;
  }
  const near = delayMs < (INTERP_DELAY_MS + FAR_DELAY_MS) / 2;
  const interval = tierInterval(near);
  const window = Math.max(WINDOW_MS, 2 * interval);
  const stale = nowMs - latest.t > STALE_INTERVALS * interval;
  const end = latest.t;

  m.speed = stale ? 0 : buffer.speedBetween(end - window, end);
  const before = buffer.speedBetween(end - 2 * window, end - window);
  const rise = m.speed - before;
  let heard: ScooterLoad = 'cruising';
  if (rise > PULL_RISE) {
    heard = 'pulling';
  } else if (rise < -COAST_DROP || m.speed < MOVING_TILES_PER_S) {
    heard = 'coasting';
  }
  if (heard !== m.pending) {
    m.pending = heard;
    m.pendingSinceMs = nowMs;
  }
  // Stopping is never held back: a scooter at rest is silent at once.
  if (nowMs - m.pendingSinceMs >= LOAD_HOLD_MS || m.speed < MOVING_TILES_PER_S) {
    m.load = m.pending;
  }

  if (!stale || latest.jump || m.bumpedForMs === end || nowMs - m.lastBumpMs < BUMP_GAP_MS) {
    return;
  }
  m.bumpedForMs = end;
  const lastStretch = buffer.speedBetween(end - 1.5 * interval, end);
  if (lastStretch >= BUMP_MIN_SPEED) {
    m.bumpImpact = Math.max(MIN_IMPACT, Math.min(1, lastStretch / RIDE_SPEED));
    m.bumpInMs = Math.max(0, end + delayMs - nowMs);
    m.lastBumpMs = nowMs;
  }
}
