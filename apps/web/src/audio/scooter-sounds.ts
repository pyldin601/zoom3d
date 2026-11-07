// The riders' scooter sounds (scooter sound spec §4): one per rider, heard from where they are drawn, its speed, load
// and bumps read from their drawn positions frame to frame (a portal or correction jump is neither speed nor a bump);
// and the local player's own, unplaced, fed from their ride and their throttle. Nothing is sent over the wire for it.
import { JUMP_TILES, type Point, RIDE_SPEED } from '@zoom3d/shared';
import type { RemotePeer } from '../net/session';
import type { AudioEngine } from './engine';
import { createScooterSound, type ScooterLoad, type ScooterSound } from './scooter-sound';

/** Others' speed is smoothed with this time constant: drawn positions step a little unevenly. */
const SMOOTH_S = 0.15;
/** Speeding up or slowing faster than this (tiles/s²) is the motor pulling, or coasting. */
const STEADY_TILES_PER_S2 = 0.5;
/** Below this a rider isn't holding a speed, only standing. */
const MOVING_TILES_PER_S = 0.3;
/** A stop sharper than any brake (10 tiles/s²) is a wall. */
const BUMP_DECELERATION = 25;
/** A drop smaller than this is a nudge, not a bump. */
const BUMP_MIN_DROP = 1.5;
/** One bump at most per rider in this long: pressing into a wall is one bump, not one per frame. */
const BUMP_GAP_S = 0.3;
/** The softest bump still heard. */
const MIN_IMPACT = 0.15;

export interface ScooterSounds {
  /** Every frame (and from the hidden ticker): starts, feeds and stops the riders' sounds. */
  sync(peers: ReadonlyMap<string, RemotePeer>, positions: ReadonlyMap<string, Point>, dtSeconds: number): void;
  /**
   * The local player's own scooter: playing while `riding`. `bump` is the ride's head-on stop this step (its speed),
   * 0 otherwise.
   */
  own(speed: number, load: ScooterLoad, bump: number, riding: boolean, dtSeconds: number): void;
  peerLeft(id: string): void;
}

/** The local player's load: their throttle pulls until top speed, then holds it. */
export function ownLoad(forward: number, speed: number): ScooterLoad {
  if (forward <= 0) {
    return 'coasting';
  }
  return speed < RIDE_SPEED ? 'pulling' : 'cruising';
}

const impactOf = (speed: number) => Math.max(MIN_IMPACT, Math.min(1, Math.abs(speed) / RIDE_SPEED));

interface Rider {
  key: string;
  sound: ScooterSound;
  lastX: number;
  lastY: number;
  /** Smoothed, for the load. */
  speed: number;
  /** Unsmoothed last frame, for a bump's sharp stop. */
  lastRaw: number;
  sinceBumpS: number;
}

export function createScooterSounds(ctx: BaseAudioContext, engine: AudioEngine): ScooterSounds {
  const riders = new Map<string, Rider>();
  let ownSound: ScooterSound | null = null;

  const stop = (id: string) => {
    const rider = riders.get(id);
    if (rider) {
      engine.detach(rider.key);
      rider.sound.dispose();
      riders.delete(id);
    }
  };

  const start = (id: string, at: Point): Rider => {
    const rider: Rider = {
      key: `scooter:${id}`,
      sound: createScooterSound(ctx),
      lastX: at.x,
      lastY: at.y,
      speed: 0,
      lastRaw: 0,
      sinceBumpS: BUMP_GAP_S,
    };
    engine.attachNode(rider.key, rider.sound.output, id);
    riders.set(id, rider);
    return rider;
  };

  const loadOf = (speed: number, rate: number): ScooterLoad => {
    if (rate > STEADY_TILES_PER_S2) {
      return 'pulling';
    }
    return rate >= -STEADY_TILES_PER_S2 && speed >= MOVING_TILES_PER_S ? 'cruising' : 'coasting';
  };

  /** One frame of a rider: their speed from the step drawn, a bump if they stopped sharper than braking can. */
  const follow = (rider: Rider, at: Point, dtSeconds: number, smoothing: number) => {
    const step = Math.hypot(at.x - rider.lastX, at.y - rider.lastY);
    const jumped = step > JUMP_TILES;
    const raw = jumped ? 0 : step / dtSeconds;
    rider.sinceBumpS += dtSeconds;
    const drop = rider.lastRaw - raw;
    if (!jumped && drop > BUMP_MIN_DROP && drop / dtSeconds > BUMP_DECELERATION && rider.sinceBumpS >= BUMP_GAP_S) {
      rider.sound.bump(impactOf(rider.lastRaw));
      rider.sinceBumpS = 0;
    }
    rider.lastRaw = raw;
    const before = rider.speed;
    rider.speed += (raw - rider.speed) * smoothing;
    rider.lastX = at.x;
    rider.lastY = at.y;
    rider.sound.set(rider.speed, loadOf(rider.speed, (rider.speed - before) / dtSeconds), dtSeconds);
  };

  return {
    sync(peers, positions, dtSeconds) {
      for (const id of riders.keys()) {
        const riding = peers.get(id)?.info.riding ?? null;
        if (riding === null || !positions.has(id)) {
          stop(id);
        }
      }
      if (dtSeconds <= 0) {
        return;
      }
      const smoothing = 1 - Math.exp(-dtSeconds / SMOOTH_S);
      for (const [id, peer] of peers) {
        const at = positions.get(id);
        if (peer.info.riding !== null && at) {
          follow(riders.get(id) ?? start(id, at), at, dtSeconds, smoothing);
        }
      }
    },
    own(speed, load, bump, riding, dtSeconds) {
      if (!riding) {
        ownSound?.dispose();
        ownSound = null;
        return;
      }
      if (!ownSound) {
        ownSound = createScooterSound(ctx);
        engine.playUnplaced(ownSound.output);
      }
      ownSound.set(speed, load, dtSeconds);
      if (bump > 0) {
        ownSound.bump(impactOf(bump));
      }
    },
    peerLeft: stop,
  };
}
