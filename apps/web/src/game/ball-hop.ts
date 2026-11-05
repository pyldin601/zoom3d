// How high the ball is drawn (ball hop spec): a client-side height under gravity, never part of where the ball is, so a
// hop can't fight the physics and costs nothing on the wire. Allocates nothing.
import type { BallMood } from '@zoom3d/shared';

/** The owner found 3 moon-like. */
const GRAVITY_TILES_PER_S2 = 14;
/** The highest it goes: its top stays under the lamps at 0.85, which the shadows' geometry relies on. */
export const KICK_HOP_TILES = 0.35;
export const PLAY_HOP_TILES = 0.15;
export const PLAY_HOP_GAP_S = 0.15;
/** The spring (owner): each rebound reaches this share of the height it fell from. */
export const REBOUND_HEIGHT_SHARE = 0.5;
/** A rebound lower than this is too small to see, so it settles. */
const SETTLE_BELOW_TILES = 0.02;

export interface BallHop {
  liftTiles: number;
  upSpeed: number;
  /** The height its current flight reaches, which its rebound takes a share of. */
  apexTiles: number;
  /** Playing, settled on the floor: how long until it leaves again. */
  restS: number;
}

export function createBallHop(): BallHop {
  return { liftTiles: 0, upSpeed: 0, apexTiles: 0, restS: 0 };
}

/** Aims at an apex instead of adding speed, so kicks in mid-air can't stack up past it. */
function launchTo(hop: BallHop, apexTiles: number): void {
  if (hop.liftTiles < apexTiles) {
    hop.upSpeed = Math.sqrt(2 * GRAVITY_TILES_PER_S2 * (apexTiles - hop.liftTiles));
    hop.apexTiles = apexTiles;
  }
}

export function kickBallHop(hop: BallHop): void {
  launchTo(hop, KICK_HOP_TILES);
}

const isResting = (hop: BallHop) => hop.liftTiles === 0 && hop.upSpeed === 0;

export function stepBallHop(hop: BallHop, dtS: number, mood: BallMood): void {
  if (mood !== 'playing') {
    hop.restS = 0;
  } else if (isResting(hop)) {
    hop.restS -= dtS;
    if (hop.restS <= 0) {
      launchTo(hop, PLAY_HOP_TILES);
    }
  }
  if (isResting(hop)) {
    return;
  }
  hop.liftTiles += hop.upSpeed * dtS - (GRAVITY_TILES_PER_S2 * dtS * dtS) / 2;
  hop.upSpeed -= GRAVITY_TILES_PER_S2 * dtS;
  if (hop.liftTiles <= 0) {
    land(hop);
  }
}

/** Rebounds from the height it fell from rather than its speed, so a long step can't throw it higher. */
function land(hop: BallHop): void {
  hop.liftTiles = 0;
  hop.upSpeed = 0;
  const rebound = hop.apexTiles * REBOUND_HEIGHT_SHARE;
  if (rebound >= SETTLE_BELOW_TILES) {
    launchTo(hop, rebound);
  } else {
    hop.apexTiles = 0;
    hop.restS = PLAY_HOP_GAP_S;
  }
}
