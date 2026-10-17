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

/** A model's size in voxels along its x (front), y and z (up). */
export interface VoxelGridSize {
  x: number;
  y: number;
  z: number;
}

/** A voxel that glows: `glow` 0 is lit like any other, 1 always shows `color` itself. */
export interface GlowingVoxel {
  color: number;
  glow: number;
}

/** Flat shading by face direction: lit from above, the front and back brighter than the sides. */
const SHADE_TOP = 1;
const SHADE_FRONT = 0.8;
const SHADE_SIDE = 0.62;

/**
 * The five faces a voxel can show (the bottom never faces the eye-height camera): normal, shade and corners on the
 * unit cube. Their order is lighting.ts's DIR_* (top, front, back, right, left).
 */
const FACES: readonly { normal: readonly [number, number, number]; shade: number; corners: readonly number[] }[] = [
  { normal: [0, 0, 1], shade: SHADE_TOP, corners: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1] },
  { normal: [1, 0, 0], shade: SHADE_FRONT, corners: [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1] },
  { normal: [-1, 0, 0], shade: SHADE_FRONT, corners: [0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1] },
  { normal: [0, 1, 0], shade: SHADE_SIDE, corners: [0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1] },
  { normal: [0, -1, 0], shade: SHADE_SIDE, corners: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1] },
];

export function glowing(color: number, amount: number): GlowingVoxel {
  return { color, glow: amount };
}

/**
 * A model from a grid of `size` voxels, each `voxel` tiles on a side; `colorAt(x, y, z)` is a packed rgb(), or 0 for
 * empty, or glowing() for a voxel that gives off its own light.
 */
export function buildModel(
  size: VoxelGridSize,
  voxel: number,
  colorAt: (x: number, y: number, z: number) => number | GlowingVoxel
): VoxelModel {
  const { x: sx, y: sy, z: sz } = size;
  const cellAt = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : colorAt(x, y, z);
  const corners: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const base: number[] = [];
  const dirs: number[] = [];
  const glows: number[] = [];
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const cell = cellAt(x, y, z);
        if (cell === 0) {
          continue;
        }
        const color = typeof cell === 'number' ? cell : cell.color;
        for (const [dir, face] of FACES.entries()) {
          const [nx, ny, nz] = face.normal;
          if (cellAt(x + nx, y + ny, z + nz) !== 0) {
            continue;
          }
          for (let i = 0; i < 12; i += 3) {
            corners.push(
              (x + (face.corners[i] as number) - sx / 2) * voxel,
              (y + (face.corners[i + 1] as number) - sy / 2) * voxel,
              (z + (face.corners[i + 2] as number)) * voxel
            );
          }
          normals.push(...face.normal);
          colors.push(scaleRgb(color, face.shade));
          base.push(color);
          dirs.push(dir);
          glows.push(typeof cell === 'number' ? 0 : cell.glow);
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

/** Camera depth of the instance's centre (the measure projectSprite and the z-buffer use), or -1 when behind. */
export function voxelDepth(view: View, v: VoxelInstance): number {
  const { planeX, planeY, invDet } = view;
  const depth = invDet * (-planeY * (v.x - view.x) + planeX * (v.y - view.y));
  return depth < MIN_DEPTH ? -1 : depth;
}

/** Per visible face: 4 screen points (x, y) and its mean depth. Grown only when a model needs more. */
let screenCorners = new Float64Array(0);
let faceDepths = new Float64Array(0);
const faceOrder: number[] = [];
/** Far to near. Math.sign: sort can't inline its comparator, and a small integer isn't boxed as a double is. */
const facesFarFirst = (a: number, b: number) => Math.sign((faceDepths[b] as number) - (faceDepths[a] as number));
/** Lamp light per face direction (r, g, b × 5), then ambient × shade added: this instance's multipliers. */
const directionLight = new Float64Array(FACES.length * 3);
/** The ambient light, r, g, b, where this instance stands. */
const ambient = new Float64Array(3);

/**
 * Draws one instance seen through `view`, depth-tested per pixel column against fb.zbuffer. With lighting, each face
 * takes the ambient share of its usual shade plus the lamps that reach its direction (sampled once, at the model's mid
 * height).
 */
export function renderVoxel(fb: Framebuffer, view: View, v: VoxelInstance, lighting: Lighting | null = null): void {
  const { model } = v;
  if (faceDepths.length < model.faceCount) {
    screenCorners = new Float64Array(model.faceCount * 8);
    faceDepths = new Float64Array(model.faceCount);
  }
  if (lighting) {
    lightDirections(lighting, v);
  }
  projectFaces(view, v);
  for (const f of faceOrder) {
    fillFace(fb, f, lighting ? litColor(model, f, directionLight) : (model.colors[f] as number));
  }
}

/** The light on each face direction of this instance into `directionLight`. */
function lightDirections(lighting: Lighting, v: VoxelInstance): void {
  directLight(lighting, v.x, v.y, v.model.height / 2, v.angle, directionLight);
  ambientAt(lighting, v.x, v.y, ambient);
  for (let dir = 0; dir < FACES.length; dir++) {
    const { shade } = FACES[dir] as (typeof FACES)[number];
    for (let ch = 0; ch < 3; ch++) {
      directionLight[dir * 3 + ch] = (directionLight[dir * 3 + ch] as number) + (ambient[ch] as number) * shade;
    }
  }
}

/**
 * Projects the faces turned towards the eye and wholly in front of it: their corners into `screenCorners`, their mean
 * depths into `faceDepths`, and the faces themselves into `faceOrder`, far to near.
 */
function projectFaces(view: View, v: VoxelInstance): void {
  const { dirX, dirY, planeX, planeY, invDet, proj, halfWidth, half } = view;
  const { corners, normals, faceCount } = v.model;
  const cos = Math.cos(v.angle);
  const sin = Math.sin(v.angle);
  faceOrder.length = 0;
  // One loop: with the back-face test and the corner projection as functions it measured 1% slower (bench:sprites).
  for (let f = 0; f < faceCount; f++) {
    const c = f * 12;
    const firstX = corners[c] as number;
    const firstY = corners[c + 1] as number;
    const nx = normals[f * 3] as number;
    const ny = normals[f * 3 + 1] as number;
    const nz = normals[f * 3 + 2] as number;
    const toEyeX = view.x - (v.x + firstX * cos - firstY * sin);
    const toEyeY = view.y - (v.y + firstX * sin + firstY * cos);
    const toEyeZ = EYE_HEIGHT - (corners[c + 2] as number);
    const turnedAway = (nx * cos - ny * sin) * toEyeX + (nx * sin + ny * cos) * toEyeY + nz * toEyeZ <= 0;
    if (turnedAway) {
      continue;
    }
    let depthSum = 0;
    let tooNear = false;
    for (let k = 0; k < 4; k++) {
      const px = corners[c + k * 3] as number;
      const py = corners[c + k * 3 + 1] as number;
      const sx = v.x + px * cos - py * sin - view.x;
      const sy = v.y + px * sin + py * cos - view.y;
      const lateral = invDet * (dirY * sx - dirX * sy);
      const depth = invDet * (-planeY * sx + planeX * sy);
      if (depth < MIN_DEPTH) {
        tooNear = true;
        break;
      }
      screenCorners[f * 8 + k * 2] = halfWidth * (1 + lateral / depth);
      screenCorners[f * 8 + k * 2 + 1] = half + (proj * (EYE_HEIGHT - (corners[c + k * 3 + 2] as number))) / depth;
      depthSum += depth;
    }
    if (tooNear) {
      continue;
    }
    faceDepths[f] = depthSum / 4;
    faceOrder.push(f);
  }
  faceOrder.sort(facesFarFirst);
}

/**
 * Face `f`'s colour in a lit room: unshaded, times `light` on its direction (see directionLight), which may overbright,
 * blended towards the colour itself as far as the face glows.
 */
function litColor({ base, dirs, glow: glows }: VoxelModel, f: number, light: Float64Array): number {
  const c = base[f] as number;
  const dir = dirs[f] as number;
  const glow = glows[f] as number;
  const lit = 1 - glow;
  let r = ((c & 0xff) * ((light[dir * 3] as number) * lit + glow)) | 0;
  let g = (((c >>> 8) & 0xff) * ((light[dir * 3 + 1] as number) * lit + glow)) | 0;
  let b = (((c >>> 16) & 0xff) * ((light[dir * 3 + 2] as number) * lit + glow)) | 0;
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

/** Fills face `f` with `colour`, row by row, where it's nearer than the column's wall. */
function fillFace(fb: Framebuffer, f: number, colour: number): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const s = f * 8;
  const depth = faceDepths[f] as number;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let k = 1; k < 8; k += 2) {
    minY = Math.min(minY, screenCorners[s + k] as number);
    maxY = Math.max(maxY, screenCorners[s + k] as number);
  }
  const firstRow = Math.max(0, Math.ceil(minY - 0.5));
  const lastRow = Math.min(h - 1, Math.ceil(maxY - 0.5) - 1);
  for (let row = firstRow; row <= lastRow; row++) {
    const y = row + 0.5;
    // A convex quad: the row of pixel centres crosses exactly two of its edges. Inline: as a function filling a span
    // object per row, it measured 5% slower (bench:sprites).
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < 4; k++) {
      const ax = screenCorners[s + k * 2] as number;
      const ay = screenCorners[s + k * 2 + 1] as number;
      const bx = screenCorners[s + ((k + 1) % 4) * 2] as number;
      const by = screenCorners[s + ((k + 1) % 4) * 2 + 1] as number;
      if ((ay <= y && y < by) || (by <= y && y < ay)) {
        const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    const firstCol = Math.max(0, Math.ceil(left - 0.5));
    const lastCol = Math.min(w - 1, Math.ceil(right - 0.5) - 1);
    for (let col = firstCol; col <= lastCol; col++) {
      if (depth < (zbuffer[col] as number)) {
        pixels[row * w + col] = colour;
      }
    }
  }
}
