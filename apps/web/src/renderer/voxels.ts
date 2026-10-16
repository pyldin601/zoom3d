// Voxel objects (robot vacuum spec §6): small models built in code from cubes, preprocessed once into their exposed
// faces, then drawn as flat-shaded quads far to near, depth-tested per column against the walls. Allocation-free per
// frame.
import { EYE_HEIGHT, MIN_DEPTH, type View } from './camera';
import { type Framebuffer, scaleRgb } from './framebuffer';
import { ambientAt, directLight, type Lighting } from './lighting';

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
  /** Per face, 0..1: how much it glows. A glowing face shows its own colour, untouched by light and shadow. */
  glow: Float32Array;
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

/** A voxel that glows: `glow` 0 is lit like any other, 1 always shows `color` itself. */
export interface Glow {
  color: number;
  glow: number;
}

export function glow(color: number, amount: number): Glow {
  return { color, glow: amount };
}

/**
 * A model from a grid of sx × sy × sz voxels; `color(x, y, z)` is a packed rgb(), or 0 for empty, or a glow() for a
 * voxel that gives off its own light.
 */
export function buildModel(
  sx: number,
  sy: number,
  sz: number,
  voxel: number,
  color: (x: number, y: number, z: number) => number | Glow
): VoxelModel {
  const at = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : color(x, y, z);
  const corners: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const base: number[] = [];
  const dirs: number[] = [];
  const glows: number[] = [];
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const v = at(x, y, z);
        if (v === 0) {
          continue;
        }
        const c = typeof v === 'number' ? v : v.color;
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
          colors.push(scaleRgb(c, f.k));
          base.push(c);
          dirs.push(d);
          glows.push(typeof v === 'number' ? 0 : v.glow);
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
    glow: Float32Array.from(glows),
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
const instanceLight = new Float64Array(FACES.length * 3);
/** The ambient light, r, g, b, where this instance stands. */
const around = new Float64Array(3);

/**
 * A face's colour in a lit room: the unshaded colour times `light` on its direction d (see instanceLight), which may
 * overbright, blended towards the colour itself as far as the face glows.
 */
function litColor(c: number, light: Float64Array, d: number, glow: number): number {
  const lit = 1 - glow;
  let r = ((c & 0xff) * ((light[d * 3] as number) * lit + glow)) | 0;
  let g = (((c >>> 8) & 0xff) * ((light[d * 3 + 1] as number) * lit + glow)) | 0;
  let b = (((c >>> 16) & 0xff) * ((light[d * 3 + 2] as number) * lit + glow)) | 0;
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
export function voxelDepth(view: View, v: VoxelInstance): number {
  const { planeX, planeY, invDet } = view;
  const depth = invDet * (-planeY * (v.x - view.x) + planeX * (v.y - view.y));
  return depth < MIN_DEPTH ? -1 : depth;
}

/**
 * Draws one instance seen through `view`, depth-tested per pixel column against fb.zbuffer. With lighting, each face
 * takes the ambient share of its usual shade plus the lamps that reach its direction (sampled once, at the model's mid
 * height).
 */
export function renderVoxel(fb: Framebuffer, view: View, v: VoxelInstance, lighting: Lighting | null = null): void {
  const n = v.model.faceCount;
  if (faceDepth.length < n) {
    screen = new Float64Array(n * 8);
    faceDepth = new Float64Array(n);
  }
  if (lighting) {
    lightDirections(lighting, v, instanceLight);
  }
  projectFaces(view, v);
  fillFaces(fb, v.model, lighting ? instanceLight : null);
}

/** The light on each face direction of this instance into `out` (see instanceLight). */
function lightDirections(lighting: Lighting, v: VoxelInstance, out: Float64Array): void {
  directLight(lighting, v.x, v.y, v.model.height / 2, v.angle, out);
  ambientAt(lighting, v.x, v.y, around);
  for (let d = 0; d < FACES.length; d++) {
    const k = (FACES[d] as (typeof FACES)[number]).k;
    for (let ch = 0; ch < 3; ch++) {
      out[d * 3 + ch] = (out[d * 3 + ch] as number) + (around[ch] as number) * k;
    }
  }
}

/**
 * Projects the faces turned towards the eye and wholly in front of it: their corners into `screen`, their mean depths
 * into `faceDepth`, and the faces themselves into `order`, far to near.
 */
function projectFaces(view: View, v: VoxelInstance): void {
  const { dirX, dirY, planeX, planeY, invDet, proj, halfWidth, half } = view;
  const { corners, normals, faceCount: n } = v.model;
  const ca = Math.cos(v.angle);
  const sa = Math.sin(v.angle);
  order.length = 0;
  for (let f = 0; f < n; f++) {
    const c = f * 12;
    // Back-face cull against the camera, using the face's first corner.
    const mx = corners[c] as number;
    const my = corners[c + 1] as number;
    const nx = normals[f * 3] as number;
    const ny = normals[f * 3 + 1] as number;
    const nz = normals[f * 3 + 2] as number;
    const toCamX = view.x - (v.x + mx * ca - my * sa);
    const toCamY = view.y - (v.y + mx * sa + my * ca);
    const toCamZ = EYE_HEIGHT - (corners[c + 2] as number);
    if ((nx * ca - ny * sa) * toCamX + (nx * sa + ny * ca) * toCamY + nz * toCamZ <= 0) {
      continue;
    }
    let sum = 0;
    let near = false;
    for (let k = 0; k < 4; k++) {
      const px = corners[c + k * 3] as number;
      const py = corners[c + k * 3 + 1] as number;
      const sx = v.x + px * ca - py * sa - view.x;
      const sy = v.y + px * sa + py * ca - view.y;
      const lateral = invDet * (dirY * sx - dirX * sy);
      const depth = invDet * (-planeY * sx + planeX * sy);
      if (depth < MIN_DEPTH) {
        near = true;
        break;
      }
      screen[f * 8 + k * 2] = halfWidth * (1 + lateral / depth);
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
}

/**
 * Fills the faces in `order` with their flat colour (lit by `light` when given), row by row, where they're nearer
 * than the column's wall.
 */
function fillFaces(fb: Framebuffer, model: VoxelModel, light: Float64Array | null): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const { colors, base, dirs, glow } = model;
  for (const f of order) {
    const s = f * 8;
    const depth = faceDepth[f] as number;
    const color = light
      ? litColor(base[f] as number, light, dirs[f] as number, glow[f] as number)
      : (colors[f] as number);
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
