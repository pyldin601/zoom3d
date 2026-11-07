import { RIDE_SPEED, type Snapshot, SnapshotBuffer } from '@zoom3d/shared';
import { describe, expect, test } from 'vitest';
import { FAR_DELAY_MS } from '../net/peer-delay';
import { createRiderMotion, readRiderMotion } from './rider-motion';

// Others' motion as their snapshots show it (scooter sound spec §4): real tick-grid snapshots, whose spacing wobbles as
// the sender's frames fall into 66 ms ticks, and which stop coming when the rider stops.
const FRAME_MS = 1000 / 60;
const NEAR_DELAY_MS = 150;

/** The rider's x at time t (ms), from a speed profile in tiles/s. */
function trace(speedAt: (tMs: number) => number, untilMs: number): (tMs: number) => number {
  const xs: number[] = [0];
  for (let t = FRAME_MS; t <= untilMs + FRAME_MS; t += FRAME_MS) {
    xs.push((xs.at(-1) ?? 0) + (speedAt(t) * FRAME_MS) / 1000);
  }
  // Positions only change on the sender's frames.
  return (tMs) => xs.at(Math.min(xs.length - 1, Math.floor(tMs / FRAME_MS))) ?? 0;
}

interface Run {
  bumps: { impact: number; inMs: number; atMs: number }[];
  loads: { atMs: number; load: string }[];
}

/**
 * Snapshots every `intervalMs` (with a few ms of wobble) while the rider moves, none once they stand still; read every
 * frame for `untilMs`. `jumpAtMs` puts a portal jump in.
 */
function run(
  speedAt: (tMs: number) => number,
  untilMs: number,
  opts: { intervalMs?: number; delayMs?: number; stopAtMs?: number; jumpAtMs?: number; wobble?: number } = {}
): Run {
  const {
    intervalMs = 66,
    delayMs = NEAR_DELAY_MS,
    stopAtMs = Number.POSITIVE_INFINITY,
    jumpAtMs = -1,
    wobble: scale = 1,
  } = opts;
  const xAt = trace(speedAt, untilMs);
  const snaps: Snapshot[] = [];
  let k = 0;
  for (let t = 0; t <= Math.min(untilMs, stopAtMs); t += intervalMs) {
    const wobble = scale * ([0, 4, -3, 2, -4, 1][k++ % 6] ?? 0);
    const jumped = jumpAtMs >= 0 && t >= jumpAtMs;
    const s: Snapshot = { t: t + wobble, x: xAt(t) + (jumped ? 50 : 0), y: 0, angle: 0 };
    snaps.push(jumped && t - intervalMs < jumpAtMs ? { ...s, jump: true } : s);
  }
  const buffer = new SnapshotBuffer();
  const motion = createRiderMotion();
  const result: Run = { bumps: [], loads: [] };
  let next = 0;
  // Past the end only for a rider who stops on purpose: otherwise the end of the snapshots would read as a crash.
  const readUntilMs = Number.isFinite(stopAtMs) ? untilMs + 2000 : untilMs;
  for (let now = 0; now <= readUntilMs; now += FRAME_MS) {
    while (next < snaps.length && (snaps.at(next)?.t ?? 0) + 10 <= now) {
      const s = snaps.at(next++);
      if (s) {
        buffer.push(s);
      }
    }
    readRiderMotion(motion, buffer, now, delayMs);
    if (motion.bumpImpact > 0) {
      result.bumps.push({ impact: motion.bumpImpact, inMs: motion.bumpInMs, atMs: now });
    }
    result.loads.push({ atMs: now, load: motion.load });
  }
  return result;
}
const share = (r: Run, load: string, fromMs: number, toMs: number) => {
  const span = r.loads.filter((l) => l.atMs >= fromMs && l.atMs <= toMs);
  return span.filter((l) => l.load === load).length / span.length;
};

describe('load', () => {
  test('a rider holding full speed is heard cruising, steadily, and never bumps', () => {
    const r = run(() => RIDE_SPEED, 60_000);
    expect(share(r, 'cruising', 2000, 60_000)).toBeGreaterThan(0.98);
    expect(r.bumps).toEqual([]);
  });

  test('with twice the network wobble a steady rider still cruises and never bumps', () => {
    const r = run(() => RIDE_SPEED, 60_000, { wobble: 2 });
    expect(share(r, 'cruising', 2000, 60_000)).toBeGreaterThan(0.95);
    expect(r.bumps).toEqual([]);
  });

  test('speeding up is heard pulling', () => {
    const r = run((t) => Math.min(RIDE_SPEED, (4 * t) / 1000), 3000);
    expect(share(r, 'pulling', 700, 1400)).toBeGreaterThan(0.9);
  });

  test('coasting is heard coasting', () => {
    const r = run((t) => Math.max(0, RIDE_SPEED - (1.5 * t) / 1000), 3000);
    expect(share(r, 'coasting', 900, 3000)).toBeGreaterThan(0.9);
  });
});

describe('bumps', () => {
  test('stopping dead at speed bumps once, timed to when the stop is drawn', () => {
    const r = run(() => RIDE_SPEED, 1000, { stopAtMs: 1000 });
    expect(r.bumps).toHaveLength(1);
    const bump = r.bumps.at(0);
    expect(bump?.impact).toBeGreaterThan(0.8);
    const lastSnapshotMs = Math.floor(1000 / 66) * 66;
    expect((bump?.atMs ?? 0) + (bump?.inMs ?? 0)).toBeCloseTo(lastSnapshotMs + NEAR_DELAY_MS, -1);
  });

  test('braking to a stop does not bump', () => {
    const r = run((t) => Math.max(0, RIDE_SPEED - (10 * t) / 1000), 1500, { stopAtMs: 700 });
    expect(r.bumps).toEqual([]);
  });

  test('going through a portal does not bump', () => {
    const r = run(() => RIDE_SPEED, 3000, { jumpAtMs: 1500 });
    expect(r.bumps).toEqual([]);
  });

  test('a far rider at full speed, updated twice a second, never bumps', () => {
    const r = run(() => RIDE_SPEED, 60_000, { intervalMs: 528, delayMs: FAR_DELAY_MS });
    expect(r.bumps).toEqual([]);
  });
});
