// How a scared ball shows (living ball spec §4): a small offset to where it is drawn, never to where it is, so it can't
// fight a push and costs nothing on the wire.
import type { BallMood } from '@zoom3d/shared';

const TREMBLE_TILES = 0.03;
const TREMBLE_HZ = 14;
/** The tremble's second axis runs at another rate, so it shivers instead of moving along a line. */
const TREMBLE_Y_RATE = 1.37;

/** Writes the offset for `mood` at `nowMs` into `out`. Allocates nothing. */
export function ballShake(mood: BallMood, nowMs: number, out: { x: number; y: number }): void {
  if (mood === 'scared') {
    const seconds = nowMs / 1000;
    out.x = TREMBLE_TILES * Math.sin(2 * Math.PI * TREMBLE_HZ * seconds);
    out.y = TREMBLE_TILES * Math.sin(2 * Math.PI * TREMBLE_HZ * TREMBLE_Y_RATE * seconds);
  } else {
    out.x = 0;
    out.y = 0;
  }
}
