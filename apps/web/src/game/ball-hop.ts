// How high the ball is drawn (ball hop spec): a client-side height under gravity, never part of where the ball is, so a
// hop can't fight the physics and costs nothing on the wire. Allocates nothing.
import type { BallMood } from '@zoom3d/shared';

/** The owner found 3 moon-like. */
const GRAVITY_TILES_PER_S2 = 14;
/** The highest it goes: its top stays under the lamps at 0.85, which the shadows' geometry relies on. */
export const KICK_HOP_TILES = 0.35;
export const PLAY_HOP_TILES = 0.15;
export const PLAY_HOP_GAP_S = 0.15;

export interface BallHop {
  liftTiles: number;
  upSpeed: number;
  /** Playing, on the floor: how long until it leaves again. */
  restS: number;
}

export function createBallHop(): BallHop {
  return { liftTiles: 0, upSpeed: 0, restS: 0 };
}

/** Aims at an apex instead of adding speed, so kicks in mid-air can't stack up past it. */
function launchTo(hop: BallHop, apexTiles: number): void {
  if (hop.liftTiles < apexTiles) {
    hop.upSpeed = Math.sqrt(2 * GRAVITY_TILES_PER_S2 * (apexTiles - hop.liftTiles));
  }
}

export function kickBallHop(hop: BallHop): void {
  launchTo(hop, KICK_HOP_TILES);
}

export function stepBallHop(hop: BallHop, dtS: number, mood: BallMood): void {
  const onFloor = hop.liftTiles === 0 && hop.upSpeed === 0;
  if (mood !== 'playing') {
    hop.restS = 0;
  } else if (onFloor) {
    hop.restS -= dtS;
    if (hop.restS <= 0) {
      launchTo(hop, PLAY_HOP_TILES);
      hop.restS = PLAY_HOP_GAP_S;
    }
  }
  hop.liftTiles += hop.upSpeed * dtS - (GRAVITY_TILES_PER_S2 * dtS * dtS) / 2;
  hop.upSpeed -= GRAVITY_TILES_PER_S2 * dtS;
  if (hop.liftTiles <= 0) {
    hop.liftTiles = 0;
    hop.upSpeed = 0;
  }
}
