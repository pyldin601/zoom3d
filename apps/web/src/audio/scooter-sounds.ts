// The riders' whines (electric scooter spec §4.4): one per rider, heard from where they are drawn, its speed read from
// their drawn positions frame to frame (a portal or correction jump is no speed); and the local player's own, unplaced,
// fed from their ride. Nothing is sent over the wire for it.
import { JUMP_TILES, type Point } from '@zoom3d/shared';
import type { RemotePeer } from '../net/session';
import type { AudioEngine } from './engine';
import { createScooterSound, type ScooterSound } from './scooter-sound';

/** Others' speed is smoothed with this time constant: drawn positions step a little unevenly. */
const SMOOTH_S = 0.15;
/** Speeding up faster than this (tiles/s²) counts as the motor pulling. */
const SPEEDING_UP = 0.5;

export interface ScooterSounds {
  /** Every frame (and from the hidden ticker): starts, feeds and stops the riders' whines. */
  sync(peers: ReadonlyMap<string, RemotePeer>, positions: ReadonlyMap<string, Point>, dtSeconds: number): void;
  /** The local player's own whine: playing while `riding`. */
  own(speed: number, speedingUp: boolean, riding: boolean): void;
  peerLeft(id: string): void;
}

interface Rider {
  key: string;
  sound: ScooterSound;
  lastX: number;
  lastY: number;
  speed: number;
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
    const rider = { key: `scooter:${id}`, sound: createScooterSound(ctx), lastX: at.x, lastY: at.y, speed: 0 };
    engine.attachNode(rider.key, rider.sound.output, id);
    riders.set(id, rider);
    return rider;
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
      const follow = 1 - Math.exp(-dtSeconds / SMOOTH_S);
      for (const [id, peer] of peers) {
        const at = positions.get(id);
        if (peer.info.riding === null || !at) {
          continue;
        }
        const rider = riders.get(id) ?? start(id, at);
        const step = Math.hypot(at.x - rider.lastX, at.y - rider.lastY);
        const raw = step > JUMP_TILES ? 0 : step / dtSeconds;
        const before = rider.speed;
        rider.speed += (raw - rider.speed) * follow;
        rider.lastX = at.x;
        rider.lastY = at.y;
        rider.sound.set(rider.speed, (rider.speed - before) / dtSeconds > SPEEDING_UP);
      }
    },
    own(speed, speedingUp, riding) {
      if (!riding) {
        ownSound?.dispose();
        ownSound = null;
        return;
      }
      if (!ownSound) {
        ownSound = createScooterSound(ctx);
        engine.playUnplaced(ownSound.output);
      }
      ownSound.set(speed, speedingUp);
    },
    peerLeft: stop,
  };
}
