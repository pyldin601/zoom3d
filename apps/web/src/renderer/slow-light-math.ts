// The physics of slow light (D39), as the local player's own motion bends and tints what they see. Angles are radians
// from the eye's facing, positive to the right (the camera plane's side). Pure and allocation-free.

/** Beyond half of c the source view would need more than about 130°. */
export const MAX_BETA = 0.5;
/** The source frame's FOV: at MAX_BETA the widest 66° view reads light from up to 64° off facing. */
export const SOURCE_FOV = (130 * Math.PI) / 180;
/** The source frame is this many times the frame's width; soft is fine (owner, 2026-11-22). */
export const SOURCE_WIDTH_FACTOR = 2;

/** Brightness goes as D to this power (the searchlight effect), within the clamps below. */
const SEARCHLIGHT_POWER = 2;
const MIN_BRIGHTNESS = 0.5;
const MAX_BRIGHTNESS = 1.4;
/** How much a channel gains per unit of ln D, toward blue ahead and red behind; the others lose half as much. */
const TINT_PER_LOG = 0.8;
const MIN_GAIN = 0.35;
const MAX_GAIN = 1.8;

/** How fast the eye moves, as a fraction of c, and which way, in radians from its facing (positive to the right). */
export interface Motion {
  beta: number;
  angle: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function wrapPi(a: number): number {
  const turns = Math.round(a / (2 * Math.PI));
  return a - turns * 2 * Math.PI;
}

/** The local player's speed as a fraction of c, capped at MAX_BETA. */
export function betaOf(speedTilesPerS: number, lightSpeed: number): number {
  return clamp(speedTilesPerS / lightSpeed, 0, MAX_BETA);
}

/** Where the light seen at `apparent` came from in the room's frame, with the eye moving at `beta` toward `motion`. */
export function sourceAngle(apparent: number, motion: number, beta: number): number {
  const seen = wrapPi(apparent - motion);
  const c = Math.cos(seen);
  const fromMotion = Math.sign(seen) * Math.acos(clamp((c - beta) / (1 - beta * c), -1, 1));
  return wrapPi(fromMotion + motion);
}

/** The Doppler factor of light seen at `apparent`: above 1 toward the motion, below behind. */
export function dopplerFactor(apparent: number, motion: number, beta: number): number {
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  return gamma * (1 + beta * Math.cos(apparent - motion));
}

/** A stylised tint and searchlight for Doppler factor `d`: per-channel gains, the identity at d = 1. */
export function tintOf(d: number, out: Rgb): Rgb {
  const shift = Math.log(d);
  const brightness = clamp(d ** SEARCHLIGHT_POWER, MIN_BRIGHTNESS, MAX_BRIGHTNESS);
  const toward = 1 + TINT_PER_LOG * Math.abs(shift);
  const others = 1 - (TINT_PER_LOG / 2) * Math.abs(shift);
  const blue = shift > 0 ? toward : others;
  const red = shift < 0 ? toward : others;
  out.r = clamp(red * brightness, MIN_GAIN, MAX_GAIN);
  out.g = clamp(others * brightness, MIN_GAIN, MAX_GAIN);
  out.b = clamp(blue * brightness, MIN_GAIN, MAX_GAIN);
  return out;
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
