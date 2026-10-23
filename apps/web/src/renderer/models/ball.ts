// The ball (ball spec §5): a voxel sphere, white with black patches like a football. The voxel renderer only turns
// models about the vertical, so the ball rolls by recolouring: its geometry stays put and every face takes the pattern
// from where the ball's own rotation has carried it. Allocation-free per frame.
import { BALL_RADIUS } from '@zoom3d/shared';
import { rgb, scaleRgb } from '../framebuffer';
import { buildModel, faceShade, type VoxelModel } from '../voxels';

const WHITE = rgb(0xf0, 0xf0, 0xf0);
const BLACK = rgb(0x20, 0x20, 0x20);
/** The dark patches' glow-in-the-dark: a faint green that shows them in a dark corner and is gone under a lamp. */
export const BALL_SHINE = rgb(0x08, 0x2a, 0x10);
const VOXEL = 0.05;
const SIZE = Math.round((2 * BALL_RADIUS) / VOXEL);

/** The patches sit round the 12 corners of an icosahedron, like a football's pentagons. */
const PHI = (1 + Math.sqrt(5)) / 2;
const ICOSAHEDRON: readonly (readonly [number, number, number])[] = [
  [0, 1, PHI],
  [0, -1, PHI],
  [0, 1, -PHI],
  [0, -1, -PHI],
  [1, PHI, 0],
  [-1, PHI, 0],
  [1, -PHI, 0],
  [-1, -PHI, 0],
  [PHI, 0, 1],
  [-PHI, 0, 1],
  [PHI, 0, -1],
  [-PHI, 0, -1],
];
const PATCHES = ICOSAHEDRON.map(([x, y, z]) => {
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n] as const;
});
/** Each patch's angular radius, so black covers about the quarter of a football's surface its pentagons do. */
const PATCH_COS = Math.cos(0.32);

/** The pattern's colour in the ball's own frame, along the unit direction (x, y, z) from its centre. */
export function ballPatternAt(x: number, y: number, z: number): number {
  for (const [px, py, pz] of PATCHES) {
    if (x * px + y * py + z * pz > PATCH_COS) {
      return BLACK;
    }
  }
  return WHITE;
}

/** 8 × 8 × 8 voxels of 0.05 tiles: a sphere of the ball's radius resting on the floor, coloured by recolourBall. */
export const BALL_MODEL = buildModel({ x: SIZE, y: SIZE, z: SIZE }, VOXEL, (x, y, z) =>
  Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2, z + 0.5 - SIZE / 2) <= SIZE / 2 ? WHITE : 0
);

/** How the ball has turned: a 3×3 rotation, row-major, from its own frame to the world's. Client-only, never sent. */
export interface BallRoll {
  m: Float64Array;
  /** Rolls since the last re-orthonormalisation. */
  sinceTidy: number;
}

export function createBallRoll(): BallRoll {
  return { m: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), sinceTidy: 0 };
}

const turn = new Float64Array(9);
const product = new Float64Array(9);
/** Floating error drifts the matrix off a rotation; this often it is straightened. */
const TIDY_EVERY = 64;

/** Rolls it (dx, dy) tiles along the floor: about the floor axis square to its travel, by distance over radius. */
export function rollBy(roll: BallRoll, dx: number, dy: number): void {
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return;
  }
  // Rolling without slipping turns it about ẑ × travel, so the top runs ahead and the contact point stands still.
  const ax = -dy / distance;
  const ay = dx / distance;
  const angle = distance / BALL_RADIUS;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  turn[0] = t * ax * ax + c;
  turn[1] = t * ax * ay;
  turn[2] = s * ay;
  turn[3] = t * ax * ay;
  turn[4] = t * ay * ay + c;
  turn[5] = -s * ax;
  turn[6] = -s * ay;
  turn[7] = s * ax;
  turn[8] = c;
  const m = roll.m;
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      product[r * 3 + col] =
        (turn[r * 3] ?? 0) * (m[col] ?? 0) +
        (turn[r * 3 + 1] ?? 0) * (m[3 + col] ?? 0) +
        (turn[r * 3 + 2] ?? 0) * (m[6 + col] ?? 0);
    }
  }
  m.set(product);
  if (++roll.sinceTidy >= TIDY_EVERY) {
    tidy(m);
    roll.sinceTidy = 0;
  }
}

/** Gram–Schmidt on the rows, then the third as the cross of the first two. */
function tidy(m: Float64Array): void {
  let [a0, a1, a2, b0, b1, b2] = [m[0] ?? 1, m[1] ?? 0, m[2] ?? 0, m[3] ?? 0, m[4] ?? 1, m[5] ?? 0];
  const na = Math.hypot(a0, a1, a2);
  a0 /= na;
  a1 /= na;
  a2 /= na;
  const dot = a0 * b0 + a1 * b1 + a2 * b2;
  b0 -= dot * a0;
  b1 -= dot * a1;
  b2 -= dot * a2;
  const nb = Math.hypot(b0, b1, b2);
  b0 /= nb;
  b1 /= nb;
  b2 /= nb;
  m.set([a0, a1, a2, b0, b1, b2, a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0]);
}

/**
 * Gives every face the pattern colour its world direction maps back to in the ball's own frame, and the dark patches
 * their shine.
 */
export function recolourBall(model: VoxelModel, roll: BallRoll): void {
  const { corners, base, colors, dirs, shine } = model;
  const m = roll.m;
  for (let i = 0; i < model.faceCount; i++) {
    const at = i * 12;
    const x = ((corners[at] ?? 0) + (corners[at + 3] ?? 0) + (corners[at + 6] ?? 0) + (corners[at + 9] ?? 0)) / 4;
    const y = ((corners[at + 1] ?? 0) + (corners[at + 4] ?? 0) + (corners[at + 7] ?? 0) + (corners[at + 10] ?? 0)) / 4;
    const z =
      ((corners[at + 2] ?? 0) + (corners[at + 5] ?? 0) + (corners[at + 8] ?? 0) + (corners[at + 11] ?? 0)) / 4 -
      BALL_RADIUS;
    const d = Math.hypot(x, y, z);
    // The inverse of a rotation is its transpose.
    const ox = ((m[0] ?? 0) * x + (m[3] ?? 0) * y + (m[6] ?? 0) * z) / d;
    const oy = ((m[1] ?? 0) * x + (m[4] ?? 0) * y + (m[7] ?? 0) * z) / d;
    const oz = ((m[2] ?? 0) * x + (m[5] ?? 0) * y + (m[8] ?? 0) * z) / d;
    const color = ballPatternAt(ox, oy, oz);
    base[i] = color;
    colors[i] = scaleRgb(color, faceShade(dirs[i] ?? 0));
    shine[i] = color === BLACK ? BALL_SHINE : 0;
  }
}

recolourBall(BALL_MODEL, createBallRoll());
