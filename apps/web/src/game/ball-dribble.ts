// The dribble's bounce (ball dribble spec §2.2): drawn only, like the hops (ball-hop.ts), so every screen bounces it
// on its own and nothing travels. A steady rhythm, fastest at the floor as a slapped ball is. Allocates nothing.

export const DRIBBLE_PERIOD_S = 0.5;
/** Under the lamps at 0.85, which the shadows' geometry relies on. */
export const DRIBBLE_HAND_TILES = 0.45;

export interface BallDribble {
  liftTiles: number;
  /** Where in its period it is, 0–1: 0 and 1 on the floor, 0.5 at the hand. */
  phase: number;
}

/** It starts at the hand, where it was picked up to. */
export function createBallDribble(): BallDribble {
  return { liftTiles: DRIBBLE_HAND_TILES, phase: 0.5 };
}

/** Returns true on the step it touches the floor. */
export function stepBallDribble(d: BallDribble, dtS: number): boolean {
  d.phase += dtS / DRIBBLE_PERIOD_S;
  const touched = d.phase >= 1;
  d.phase %= 1;
  const fromHand = 2 * d.phase - 1;
  d.liftTiles = DRIBBLE_HAND_TILES * (1 - fromHand * fromHand);
  return touched;
}
