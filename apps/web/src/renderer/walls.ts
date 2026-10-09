// Column-by-column textured wall renderer with flat ceiling and floor.
import { castRay, createRayHit, type GameMap, type PlayerState } from '@zoom3d/shared';
import { type Framebuffer, rgb } from './framebuffer';
import { TEX } from './textures';

export const FOV = (66 * Math.PI) / 180;
export const CEILING = rgb(0x38, 0x38, 0x38);
export const FLOOR = rgb(0x70, 0x70, 0x70);

const hit = createRayHit();

/** Darkens a colour to 70% (y-side walls), keeping alpha. */
export function shade(c: number): number {
  const r = ((c & 0xff) * 0.7) | 0;
  const g = (((c >>> 8) & 0xff) * 0.7) | 0;
  const b = (((c >>> 16) & 0xff) * 0.7) | 0;
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

export function renderWalls(fb: Framebuffer, map: GameMap, p: PlayerState, textures: Uint32Array[]): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const dirX = Math.cos(p.angle);
  const dirY = Math.sin(p.angle);
  const planeLen = Math.tan(FOV / 2);
  // Camera plane points to the right of facing: (-sin, cos) in y-down coordinates.
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  const proj = w / 2 / planeLen;
  const half = h / 2;
  const size = TEX;

  for (let col = 0; col < w; col++) {
    const cameraX = (2 * col) / w - 1;
    const rayX = dirX + planeX * cameraX;
    const rayY = dirY + planeY * cameraX;
    castRay(map, p.x, p.y, rayX, rayY, hit);
    zbuffer[col] = hit.distance;

    const lineH = hit.tile === 0 ? 0 : proj / hit.distance;
    const start = Math.max(0, Math.floor(half - lineH / 2));
    const end = Math.min(h, Math.floor(half + lineH / 2));

    for (let y = 0; y < start; y++) {
      pixels[y * w + col] = CEILING;
    }
    if (end > start) {
      const tex = textures[hit.tile] as Uint32Array;
      let texX = Math.floor(hit.wallX * size);
      if ((hit.side === 0 && rayX > 0) || (hit.side === 1 && rayY < 0)) {
        texX = size - texX - 1;
      }
      const step = size / lineH;
      let texPos = (start - half + lineH / 2) * step;
      for (let y = start; y < end; y++) {
        const texY = Math.min(size - 1, texPos | 0);
        texPos += step;
        const c = tex[texY * size + texX] as number;
        pixels[y * w + col] = hit.side === 1 ? shade(c) : c;
      }
    }
    for (let y = Math.max(end, start); y < h; y++) {
      pixels[y * w + col] = FLOOR;
    }
  }
}
