// The riders' scooter sounds (scooter sound spec §4): one per rider, heard from where they are drawn, their speed, load
// and bumps read from the poses the server sent of them (rider-motion.ts); and the local player's own, unplaced, fed
// from their ride and their throttle. Nothing is sent over the wire for it.
import { type Point, RIDE_SPEED } from '@zoom3d/shared';
import type { RemotePeer } from '../net/session';
import type { AudioEngine } from './engine';
import { createRiderMotion, type RiderMotion, readRiderMotion } from './rider-motion';
import { createScooterSound, type ScooterLoad, type ScooterSound } from './scooter-sound';

/** A stop slower than this (tiles/s) is a nudge against the wall, not a bump: throttling into one rocks at a crawl. */
const BUMP_MIN_SPEED = 1.5;
/** One bump at most in this long. */
const BUMP_GAP_S = 0.3;
const MIN_IMPACT = 0.15;

export interface ScooterSounds {
  /** Every frame (and from the hidden ticker), at `nowMs` on the session's clock: starts, feeds and stops the riders. */
  sync(
    peers: ReadonlyMap<string, RemotePeer>,
    positions: ReadonlyMap<string, Point>,
    dtSeconds: number,
    nowMs: number
  ): void;
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

interface Rider {
  sound: ScooterSound;
  motion: RiderMotion;
}

export function createScooterSounds(ctx: BaseAudioContext, engine: AudioEngine): ScooterSounds {
  const riders = new Map<string, Rider>();
  /** Engine keys are per ride, not per rider: a fading ride lets go of its own key, never a newer ride's. */
  const keys = new Map<ScooterSound, string>();
  let rides = 0;
  let ownSound: ScooterSound | null = null;
  let sinceOwnBumpS = BUMP_GAP_S;

  const stop = (id: string) => {
    const rider = riders.get(id);
    if (rider) {
      riders.delete(id);
      const key = keys.get(rider.sound);
      rider.sound.dispose(() => {
        keys.delete(rider.sound);
        if (key !== undefined) {
          engine.detach(key);
        }
      });
    }
  };

  const start = (id: string): Rider => {
    const rider: Rider = { sound: createScooterSound(ctx), motion: createRiderMotion() };
    const key = `scooter:${id}:${++rides}`;
    keys.set(rider.sound, key);
    engine.attachNode(key, rider.sound.output, id);
    riders.set(id, rider);
    return rider;
  };

  return {
    sync(peers, positions, dtSeconds, nowMs) {
      for (const id of riders.keys()) {
        const riding = peers.get(id)?.info.riding ?? null;
        if (riding === null || !positions.has(id)) {
          stop(id);
        }
      }
      for (const [id, peer] of peers) {
        if (peer.info.riding === null || !positions.has(id)) {
          continue;
        }
        const { sound, motion } = riders.get(id) ?? start(id);
        readRiderMotion(motion, peer.buffer, nowMs, peer.delay.value);
        sound.set(motion.speed, motion.load, dtSeconds);
        if (motion.bumpImpact > 0) {
          sound.bump(motion.bumpImpact, motion.bumpInMs / 1000);
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
      sinceOwnBumpS += Math.max(dtSeconds, 0);
      if (bump >= BUMP_MIN_SPEED && sinceOwnBumpS >= BUMP_GAP_S) {
        ownSound.bump(Math.max(MIN_IMPACT, Math.min(1, bump / RIDE_SPEED)));
        sinceOwnBumpS = 0;
      }
    },
    peerLeft: stop,
  };
}
