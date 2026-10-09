// Billboard disc avatars, depth-tested per column against the wall z-buffer, each with a soft
// shadow on the floor right under it.
import type { PlayerState } from '@zoom3d/shared';
import { FACE_SIZE } from '../media/faces';
import { type Framebuffer, rgb } from './framebuffer';
import { FOV, shade } from './walls';

export const AVATAR_RADIUS = 0.35; // tiles
const MIN_DEPTH = 0.1;
const RING = 0.85; // fraction of the radius where the shaded edge starts
/** Floor shadow radius (tiles) and how much it darkens the floor at its centre. */
export const SHADOW_RADIUS = 0.3;
const SHADOW_DARKNESS = 0.33;
/** Retro look: the shadow is a low-res floor texture (texel in tiles) with flat darkness bands. */
const SHADOW_TEXEL = 1 / 16;
export const SHADOW_LEVELS = 3;
/** The camera (and every disc centre) sits at half wall height above the floor. */
const EYE_HEIGHT = 0.5;

export interface Sprite {
  x: number;
  y: number;
  /** Packed like rgb(). */
  color: number;
  /** FACE_SIZE² texels shown inside the ring, or null for a flat disc. */
  face: Uint32Array | null;
  /** 0..1: brightens the ring while the person talks. */
  speaking: number;
}

const SPEAKING_GLOW = 0.8;

/** Mixes a packed colour toward white by k (0..1), keeping alpha. */
export function mixWhite(c: number, k: number): number {
  const mix = (v: number) => (v + (255 - v) * k) | 0;
  const r = mix(c & 0xff);
  const g = mix((c >>> 8) & 0xff);
  const b = mix((c >>> 16) & 0xff);
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Scales a packed colour's RGB by f (0..1), keeping alpha. */
function darken(c: number, f: number): number {
  const r = ((c & 0xff) * f) | 0;
  const g = (((c >>> 8) & 0xff) * f) | 0;
  const b = (((c >>> 16) & 0xff) * f) | 0;
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

export interface Projection {
  /** Internal-resolution pixels. */
  screenX: number;
  depth: number;
  /** Diameter in internal-resolution pixels. */
  size: number;
}

export function hexToRgb(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

/** Camera-space projection matching renderWalls. Returns false when behind the camera. */
export function projectSprite(p: PlayerState, x: number, y: number, fbWidth: number, out: Projection): boolean {
  const planeLen = Math.tan(FOV / 2);
  const dirX = Math.cos(p.angle);
  const dirY = Math.sin(p.angle);
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  const sx = x - p.x;
  const sy = y - p.y;
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  const lateral = invDet * (dirY * sx - dirX * sy);
  const depth = invDet * (-planeY * sx + planeX * sy);
  if (depth < MIN_DEPTH) return false;
  const proj = fbWidth / 2 / planeLen;
  out.screenX = (fbWidth / 2) * (1 + lateral / depth);
  out.depth = depth;
  out.size = (2 * AVATAR_RADIUS * proj) / depth;
  return true;
}

/**
 * Darkens the visible floor within SHADOW_RADIUS of (sx, sy), seen `depth` tiles ahead. Each
 * floor pixel is cast back to the floor point it shows; pixels nearer than the column's wall only.
 */
function renderShadow(fb: Framebuffer, p: PlayerState, sx: number, sy: number, depth: number): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const planeLen = Math.tan(FOV / 2);
  const proj = w / 2 / planeLen;
  const half = h / 2;
  const dirX = Math.cos(p.angle);
  const dirY = Math.sin(p.angle);
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  const near = Math.max(depth - SHADOW_RADIUS, MIN_DEPTH);
  const floorK = EYE_HEIGHT * proj;
  const row0 = Math.max(Math.ceil(half), Math.floor(half + floorK / (depth + SHADOW_RADIUS)));
  const row1 = Math.min(h - 1, Math.ceil(half + floorK / near));
  const centreX = (w / 2) * (1 + lateralOf(p, sx, sy, dirX, dirY, planeX, planeY) / depth);
  const halfW = (SHADOW_RADIUS * proj) / near;
  const col0 = Math.max(0, Math.floor(centreX - halfW));
  const col1 = Math.min(w - 1, Math.ceil(centreX + halfW));
  const r2 = SHADOW_RADIUS * SHADOW_RADIUS;
  for (let col = col0; col <= col1; col++) {
    const cameraX = (2 * col) / w - 1;
    const rayX = dirX + planeX * cameraX;
    const rayY = dirY + planeY * cameraX;
    const wall = zbuffer[col] as number;
    for (let row = row0; row <= row1; row++) {
      const dist = floorK / (row + 0.5 - half);
      if (dist >= wall) continue;
      // Snap the floor point to its texel centre (grid centred on the avatar, so it stays symmetric).
      const dx = (Math.floor((p.x + rayX * dist - sx) / SHADOW_TEXEL) + 0.5) * SHADOW_TEXEL;
      const dy = (Math.floor((p.y + rayY * dist - sy) / SHADOW_TEXEL) + 0.5) * SHADOW_TEXEL;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      const band = Math.ceil((1 - d2 / r2) * SHADOW_LEVELS) / SHADOW_LEVELS;
      const i = row * w + col;
      pixels[i] = darken(pixels[i] as number, 1 - SHADOW_DARKNESS * band);
    }
  }
}

function lateralOf(
  p: PlayerState,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  planeX: number,
  planeY: number
): number {
  const invDet = 1 / (planeX * dirY - dirX * planeY);
  return invDet * (dirY * (x - p.x) - dirX * (y - p.y));
}

const projections: Projection[] = [];
const visible: number[] = [];

export function renderSprites(fb: Framebuffer, p: PlayerState, sprites: readonly Sprite[]): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  visible.length = 0;
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i] as Sprite;
    if (!projections[i]) projections[i] = { screenX: 0, depth: 0, size: 0 };
    const proj = projections[i] as Projection;
    if (projectSprite(p, s.x, s.y, w, proj)) visible.push(i);
  }
  visible.sort((a, b) => (projections[b] as Projection).depth - (projections[a] as Projection).depth);

  // Shadows lie on the floor, so every disc (drawn next) covers every shadow.
  for (const i of visible) {
    const s = sprites[i] as Sprite;
    renderShadow(fb, p, s.x, s.y, (projections[i] as Projection).depth);
  }

  const half = h / 2;
  const faceSize = FACE_SIZE;
  for (const i of visible) {
    const { screenX, depth, size } = projections[i] as Projection;
    const { color, face, speaking } = sprites[i] as Sprite;
    const ring = speaking > 0 ? mixWhite(color, Math.min(speaking, 1) * SPEAKING_GLOW) : color;
    const edge = face ? ring : shade(ring);
    const r = size / 2;
    const r2 = r * r;
    const ring2 = r2 * RING * RING;
    const inner = r * RING;
    const x0 = Math.max(0, Math.floor(screenX - r));
    const x1 = Math.min(w - 1, Math.ceil(screenX + r));
    const y0 = Math.max(0, Math.floor(half - r));
    const y1 = Math.min(h - 1, Math.ceil(half + r));
    for (let col = x0; col <= x1; col++) {
      if (depth >= (zbuffer[col] as number)) continue;
      const dx = col + 0.5 - screenX;
      for (let row = y0; row <= y1; row++) {
        const dy = row + 0.5 - half;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        if (d2 > ring2) {
          pixels[row * w + col] = edge;
        } else if (face) {
          // Map the inner circle onto the whole texture (not mirrored: we face the person).
          const u = Math.min(faceSize - 1, Math.max(0, ((dx / inner + 1) * 0.5 * faceSize) | 0));
          const v = Math.min(faceSize - 1, Math.max(0, ((dy / inner + 1) * 0.5 * faceSize) | 0));
          pixels[row * w + col] = face[v * faceSize + u] as number;
        } else {
          pixels[row * w + col] = color;
        }
      }
    }
  }
}
