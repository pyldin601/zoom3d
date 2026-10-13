// Voxel objects (robot vacuum spec §6): small models built in code from cubes, preprocessed once into their exposed
// faces, then drawn as flat-shaded quads far to near, depth-tested per column against the walls. Allocation-free per
// frame.
import type { PlayerState } from '@zoom3d/shared';
import { EYE_HEIGHT, MIN_DEPTH } from './camera';
import type { Framebuffer } from './framebuffer';
import { directLight, type Lighting } from './lighting';

export interface VoxelModel {
  /** Voxel edge in tiles. */
  voxel: number;
  /** Exposed faces: 4 corners × (x, y, z) in tiles, model space (+x front, +z up, origin at the footprint's centre on the
   * floor). The corners go round the quad. */
  corners: Float32Array;
  /** Unit normal per face (x, y, z), model space. */
  normals: Float32Array;
  /** Packed rgb() colour per face, already shaded by its normal. */
  colors: Uint32Array;
  /** The same colours unshaded, and each face's direction (lighting.ts DIR_*), for lit rooms. */
  base: Uint32Array;
  dirs: Uint8Array;
  /** Top of the model above the floor, in tiles. */
  height: number;
  faceCount: number;
  /** Floor shadow radius in tiles: half the footprint's larger side. */
  shadowRadius: number;
}

export interface VoxelInstance {
  model: VoxelModel;
  x: number;
  y: number;
  /** Radians, like a player's: the model's +x faces (cos, sin). */
  angle: number;
}

/** Flat shading by face direction: lit from above, the front and back brighter than the sides. */
const SHADE_TOP = 1;
const SHADE_FRONT = 0.8;
const SHADE_SIDE = 0.62;

/** The five faces a voxel can show (the bottom never faces the eye-height camera): normal and corners, unit cube.
 * Their order is lighting.ts's DIR_* (top, front, back, right, left). */
const FACES: readonly { n: readonly [number, number, number]; k: number; q: readonly number[] }[] = [
  { n: [0, 0, 1], k: SHADE_TOP, q: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1] },
  { n: [1, 0, 0], k: SHADE_FRONT, q: [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1] },
  { n: [-1, 0, 0], k: SHADE_FRONT, q: [0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1] },
  { n: [0, 1, 0], k: SHADE_SIDE, q: [0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1] },
  { n: [0, -1, 0], k: SHADE_SIDE, q: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1] },
];

/** Scales a packed colour's RGB by k, keeping alpha. */
function scale(c: number, k: number): number {
  const r = ((c & 0xff) * k) | 0;
  const g = (((c >>> 8) & 0xff) * k) | 0;
  const b = (((c >>> 16) & 0xff) * k) | 0;
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

/** A model from a grid of sx × sy × sz voxels; `color(x, y, z)` is a packed rgb(), or 0 for empty. */
export function buildModel(
  sx: number,
  sy: number,
  sz: number,
  voxel: number,
  color: (x: number, y: number, z: number) => number
): VoxelModel {
  const at = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : color(x, y, z);
  const corners: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const base: number[] = [];
  const dirs: number[] = [];
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const c = at(x, y, z);
        if (c === 0) {
          continue;
        }
        for (let d = 0; d < FACES.length; d++) {
          const f = FACES[d] as (typeof FACES)[number];
          if (at(x + f.n[0], y + f.n[1], z + f.n[2]) !== 0) {
            continue;
          }
          for (let i = 0; i < 12; i += 3) {
            corners.push(
              (x + (f.q[i] as number) - sx / 2) * voxel,
              (y + (f.q[i + 1] as number) - sy / 2) * voxel,
              (z + (f.q[i + 2] as number)) * voxel
            );
          }
          normals.push(...f.n);
          colors.push(scale(c, f.k));
          base.push(c);
          dirs.push(d);
        }
      }
    }
  }
  return {
    voxel,
    corners: Float32Array.from(corners),
    normals: Float32Array.from(normals),
    colors: Uint32Array.from(colors),
    base: Uint32Array.from(base),
    dirs: Uint8Array.from(dirs),
    height: sz * voxel,
    faceCount: colors.length,
    shadowRadius: (Math.max(sx, sy) * voxel) / 2,
  };
}

/** Per visible face: 4 screen points (x, y) and its mean depth. Grown only when a model needs more. */
let screen = new Float64Array(0);
let faceDepth = new Float64Array(0);
const order: number[] = [];
const byDepth = (a: number, b: number) => (faceDepth[b] as number) - (faceDepth[a] as number);
/** Lamp light per face direction (r, g, b × 5), then ambient × shade added: this instance's multipliers. */
const light = new Float64Array(FACES.length * 3);

/** A face's colour in a lit room: the unshaded colour times the light on its direction, which may overbright. */
function litColor(c: number, d: number): number {
  let r = ((c & 0xff) * (light[d * 3] as number)) | 0;
  let g = (((c >>> 8) & 0xff) * (light[d * 3 + 1] as number)) | 0;
  let b = (((c >>> 16) & 0xff) * (light[d * 3 + 2] as number)) | 0;
  if (r > 255) {
    r = 255;
  }
  if (g > 255) {
    g = 255;
  }
  if (b > 255) {
    b = 255;
  }
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Camera depth of the instance's centre (the measure projectSprite and the z-buffer use), or -1 when behind. */
export function voxelDepth(fb: Framebuffer, p: PlayerState, v: VoxelInstance): number {
  const planeLen = Math.tan(fb.fov / 2);
  const dirX = Math.cos(p.angle);
  const dirY = Math.sin(p.angle);
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  const depth = invDet * (-planeY * (v.x - p.x) + planeX * (v.y - p.y));
  return depth < MIN_DEPTH ? -1 : depth;
}

/**
 * Draws one instance, depth-tested per pixel column against fb.zbuffer. With lighting, each face takes the ambient
 * share of its usual shade plus the lamps that reach its direction (sampled once, at the model's mid height).
 */
export function renderVoxel(fb: Framebuffer, p: PlayerState, v: VoxelInstance, lighting: Lighting | null = null): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const { model } = v;
  const n = model.faceCount;
  if (faceDepth.length < n) {
    screen = new Float64Array(n * 8);
    faceDepth = new Float64Array(n);
  }
  const planeLen = Math.tan(fb.fov / 2);
  const dirX = Math.cos(p.angle);
  const dirY = Math.sin(p.angle);
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  const proj = w / 2 / planeLen;
  const half = h / 2;
  const ca = Math.cos(v.angle);
  const sa = Math.sin(v.angle);
  const { corners, normals, colors, base, dirs } = model;
  if (lighting) {
    directLight(lighting, v.x, v.y, model.height / 2, v.angle, light);
    for (let d = 0; d < FACES.length; d++) {
      const amb = lighting.ambient * (FACES[d] as (typeof FACES)[number]).k;
      for (let ch = 0; ch < 3; ch++) {
        light[d * 3 + ch] = (light[d * 3 + ch] as number) + amb;
      }
    }
  }

  order.length = 0;
  for (let f = 0; f < n; f++) {
    const c = f * 12;
    // Back-face cull against the camera, using the face's first corner.
    const mx = corners[c] as number;
    const my = corners[c + 1] as number;
    const nx = normals[f * 3] as number;
    const ny = normals[f * 3 + 1] as number;
    const nz = normals[f * 3 + 2] as number;
    const toCamX = p.x - (v.x + mx * ca - my * sa);
    const toCamY = p.y - (v.y + mx * sa + my * ca);
    const toCamZ = EYE_HEIGHT - (corners[c + 2] as number);
    if ((nx * ca - ny * sa) * toCamX + (nx * sa + ny * ca) * toCamY + nz * toCamZ <= 0) {
      continue;
    }
    let sum = 0;
    let near = false;
    for (let k = 0; k < 4; k++) {
      const px = corners[c + k * 3] as number;
      const py = corners[c + k * 3 + 1] as number;
      const sx = v.x + px * ca - py * sa - p.x;
      const sy = v.y + px * sa + py * ca - p.y;
      const lateral = invDet * (dirY * sx - dirX * sy);
      const depth = invDet * (-planeY * sx + planeX * sy);
      if (depth < MIN_DEPTH) {
        near = true;
        break;
      }
      screen[f * 8 + k * 2] = (w / 2) * (1 + lateral / depth);
      screen[f * 8 + k * 2 + 1] = half + (proj * (EYE_HEIGHT - (corners[c + k * 3 + 2] as number))) / depth;
      sum += depth;
    }
    if (near) {
      continue;
    }
    faceDepth[f] = sum / 4;
    order.push(f);
  }
  order.sort(byDepth);

  for (const f of order) {
    const s = f * 8;
    const depth = faceDepth[f] as number;
    const color = lighting ? litColor(base[f] as number, dirs[f] as number) : (colors[f] as number);
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let k = 1; k < 8; k += 2) {
      minY = Math.min(minY, screen[s + k] as number);
      maxY = Math.max(maxY, screen[s + k] as number);
    }
    const row0 = Math.max(0, Math.ceil(minY - 0.5));
    const row1 = Math.min(h - 1, Math.ceil(maxY - 0.5) - 1);
    for (let row = row0; row <= row1; row++) {
      const yc = row + 0.5;
      // A convex quad: the pixel-centre row crosses exactly two of its edges.
      let left = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < 4; k++) {
        const ax = screen[s + k * 2] as number;
        const ay = screen[s + k * 2 + 1] as number;
        const bx = screen[s + ((k + 1) % 4) * 2] as number;
        const by = screen[s + ((k + 1) % 4) * 2 + 1] as number;
        if ((ay <= yc && yc < by) || (by <= yc && yc < ay)) {
          const x = ax + ((yc - ay) * (bx - ax)) / (by - ay);
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
      const col0 = Math.max(0, Math.ceil(left - 0.5));
      const col1 = Math.min(w - 1, Math.ceil(right - 0.5) - 1);
      for (let col = col0; col <= col1; col++) {
        if (depth < (zbuffer[col] as number)) {
          pixels[row * w + col] = color;
        }
      }
    }
  }
}
