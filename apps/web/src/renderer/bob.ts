// Walking bob, driven by distance walked so it follows real speed and stops when the walker stops.
// One tracker per moving thing (the local player, each peer), updated every frame; no allocations.

/** Tiles walked per step: the lift goes 0 → 1 → 0 over one stride. */
export const BOB_STRIDE = 0.6;
/** The drink trails the avatar by this much phase (radians), so it swings behind the step. */
const ITEM_LAG = 0.9;
/** Seconds for the bob to settle after stopping. */
const EASE_OUT = 0.15;
/** A jump larger than this in one frame (resume, correction) is not walking. */
const MAX_STEP = 1;

export interface Bob {
  /** 0..1: how far up the avatar is in its step. */
  readonly lift: number;
  /** 0..1: the same for the drink, half a step behind. */
  readonly itemLift: number;
  /** −1..1: side to side, one way per step (left foot, right foot). */
  readonly sway: number;
  update(x: number, y: number, dt: number): void;
}

export function createBob(): Bob {
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let phase = 0;
  let amp = 0;
  const bob = {
    lift: 0,
    itemLift: 0,
    sway: 0,
    update(x: number, y: number, dt: number) {
      const step = Math.hypot(x - lastX, y - lastY);
      lastX = x;
      lastY = y;
      if (step > 1e-4 && step < MAX_STEP) {
        phase += (Math.PI * step) / BOB_STRIDE;
        amp = 1;
      } else {
        amp = Math.max(0, amp - dt / EASE_OUT);
      }
      bob.lift = amp * Math.abs(Math.sin(phase));
      bob.itemLift = amp * Math.abs(Math.sin(phase - ITEM_LAG));
      bob.sway = amp * Math.sin(phase);
    },
  };
  return bob;
}
