// The physics of slow light (D39, D40), as the local player's own motion bends what they see and shifts its light.
// Angles are radians from the eye's facing, positive to the right (the camera plane's side). Pure and allocation-free.

/** Beyond half of c the source view would need more than about 132° by 82°. */
export const MAX_BETA = 0.5;
/** The source frame is this many times the frame's width; soft is fine (owner, 2026-11-22). */
export const SOURCE_WIDTH_FACTOR = 2;

/** How fast the eye moves, as a fraction of c, and which way, in radians from its facing (positive to the right). */
export interface Motion {
  beta: number;
  angle: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Below this fraction of c the eye is at rest: an eased speed would otherwise take a minute to reach exactly 0. */
const REST_BETA = 0.01;

/** The local player's speed as a fraction of c, capped at MAX_BETA, and 0 near rest. */
export function betaOf(speedTilesPerS: number, lightSpeed: number): number {
  const beta = clamp(speedTilesPerS / lightSpeed, 0, MAX_BETA);
  return beta < REST_BETA ? 0 : beta;
}

/** A unit direction in camera space: x along the facing, y to the right (the camera plane), z down (rows grow down). */
export interface Dir {
  x: number;
  y: number;
  z: number;
}

/**
 * Where light seen along `n` came from in the room's frame, with the eye moving at `beta` toward `motionAngle` (in the
 * horizontal plane, radians from the facing, right positive). With −beta, the other way round: where light from `n`
 * is seen. The direction turns within the plane it shares with the motion. Writes `out`, which may be `n`.
 */
export function aberrate(n: Dir, motionAngle: number, beta: number, out: Dir): Dir {
  const vx = Math.cos(motionAngle);
  const vy = Math.sin(motionAngle);
  const seen = n.x * vx + n.y * vy;
  const px = n.x - seen * vx;
  const py = n.y - seen * vy;
  const pz = n.z;
  const across = Math.hypot(px, py, pz);
  if (beta === 0 || across < 1e-12) {
    out.x = n.x;
    out.y = n.y;
    out.z = n.z;
    return out;
  }
  const along = clamp((seen - beta) / (1 - beta * seen), -1, 1);
  const side = Math.sqrt(1 - along * along) / across;
  out.x = along * vx + side * px;
  out.y = along * vy + side * py;
  out.z = side * pz;
  return out;
}

/** The Doppler factor of light seen along `n`: above 1 toward the motion, below behind, 1/γ side-on. */
export function dopplerAlong(n: Dir, motionAngle: number, beta: number): number {
  if (beta === 0) {
    return 1;
  }
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  return 1 / (gamma * (1 - beta * (n.x * Math.cos(motionAngle) + n.y * Math.sin(motionAngle))));
}
