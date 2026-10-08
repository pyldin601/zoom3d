// Billboard disc avatars, depth-tested per column against the wall z-buffer.
import type { PlayerState } from '@zoom3d/shared';
import { type Framebuffer, rgb } from './framebuffer';
import { FOV, shade } from './walls';

export const AVATAR_RADIUS = 0.35; // tiles
const MIN_DEPTH = 0.1;
const RING = 0.85; // fraction of the radius where the shaded edge starts

export interface Sprite {
  x: number;
  y: number;
  /** Packed like rgb(). */
  color: number;
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
export function projectSprite(
  p: PlayerState,
  x: number,
  y: number,
  fbWidth: number,
  out: Projection,
): boolean {
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

  const half = h / 2;
  for (const i of visible) {
    const { screenX, depth, size } = projections[i] as Projection;
    const color = (sprites[i] as Sprite).color;
    const edge = shade(color);
    const r = size / 2;
    const r2 = r * r;
    const ring2 = r2 * RING * RING;
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
        pixels[row * w + col] = d2 > ring2 ? edge : color;
      }
    }
  }
}
