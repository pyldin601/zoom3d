// How far in the past each peer is drawn (6d spec §2.3). The server sends near peers every tick and far ones twice
// a second, so a far peer drawn at the near delay would stand still and jump. Each peer gets the delay of its tier instead,
// changed gradually so crossing the line never jumps.
import { FANOUT_TICK_MS, FAR_INTERVAL_MS, INTERP_DELAY_MS, NEAR_TILES, type SnapshotBuffer } from '@zoom3d/shared';

/** Far updates come every FAR_INTERVAL_MS plus up to a tick, plus network jitter. */
export const FAR_DELAY_MS = 750;
/** The delay changes at most this many ms per ms: drawn time slows to half speed or runs 1.5×, never backwards. */
const SLEW = 0.5;

/**
 * Whether the server sends this peer every tick. Judged a tile inside the server's line: near the line the server's
 * view and ours differ, and drawing a near peer late is smooth, while drawing a far peer early is choppy.
 */
export function nearTier(px: number, py: number, x: number, y: number): boolean {
  return Math.hypot(x - px, y - py) <= NEAR_TILES - 1;
}

/** How often the server sends a moving peer of this tier: far ones go out on the first tick FAR_INTERVAL_MS after. */
export function tierInterval(near: boolean): number {
  return near ? FANOUT_TICK_MS : Math.ceil(FAR_INTERVAL_MS / FANOUT_TICK_MS) * FANOUT_TICK_MS;
}

export class PeerDelay {
  value = INTERP_DELAY_MS;
  private at = Number.NaN;

  /** The delay to draw this peer with at time `t`. Allocation-free: called every frame. */
  update(t: number, near: boolean): number {
    const target = near ? INTERP_DELAY_MS : FAR_DELAY_MS;
    if (Number.isNaN(this.at)) {
      this.value = target;
    } else {
      const step = Math.max(0, t - this.at) * SLEW;
      this.value = this.value < target ? Math.min(target, this.value + step) : Math.max(target, this.value - step);
    }
    this.at = t;
    return this.value;
  }
}

/**
 * The server sends nothing while a peer stands still, so its next update follows a long gap. Interpolating across that
 * gap would draw it already most of the way to the new pose: hold the last pose until one interval before `t`. A gap
 * up to two ticks longer than the interval is not a pause: the client's and the server's timers drift, so two moves
 * now and then land in one tick and the first is never sent. Holding then would stutter.
 */
export function holdBefore(buffer: SnapshotBuffer, t: number, intervalMs: number): void {
  const last = buffer.latest();
  if (last && last.t < t - intervalMs - 2 * FANOUT_TICK_MS) {
    buffer.push({ t: t - intervalMs, x: last.x, y: last.y, angle: last.angle });
  }
}
