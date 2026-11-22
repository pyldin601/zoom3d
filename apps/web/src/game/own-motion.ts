// The local player's own velocity, as slow light (D39) bends their view by it.
import { JUMP_TILES } from '@zoom3d/shared';
import { betaOf } from '../renderer/slow-light-math';

/** How fast the eye moves, as a fraction of c, and which way, in radians from its facing (positive to the right). */
export interface Motion {
  beta: number;
  angle: number;
}

export interface OwnMotion {
  /** One pooled Motion, refilled from where the local player stands this frame. */
  update(x: number, y: number, eyeAngle: number, dtS: number, lightSpeed: number): Motion;
  reset(): void;
}

/** Frame-to-frame steps are uneven: the velocity is eased toward each one over this long. */
const SMOOTHING_S = 0.1;

export function createOwnMotion(): OwnMotion {
  const motion: Motion = { beta: 0, angle: 0 };
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let vx = 0;
  let vy = 0;

  return {
    update(x, y, eyeAngle, dtS, lightSpeed) {
      const stepX = x - lastX;
      const stepY = y - lastY;
      lastX = x;
      lastY = y;
      const throughPortal = Math.hypot(stepX, stepY) > JUMP_TILES;
      if (dtS > 0 && Number.isFinite(stepX) && !throughPortal) {
        const ease = 1 - Math.exp(-dtS / SMOOTHING_S);
        vx += (stepX / dtS - vx) * ease;
        vy += (stepY / dtS - vy) * ease;
      }
      motion.beta = betaOf(Math.hypot(vx, vy), lightSpeed);
      motion.angle = motion.beta === 0 ? 0 : Math.atan2(vy, vx) - eyeAngle;
      return motion;
    },
    reset() {
      lastX = Number.NaN;
      lastY = Number.NaN;
      vx = 0;
      vy = 0;
      motion.beta = 0;
      motion.angle = 0;
    },
  };
}
