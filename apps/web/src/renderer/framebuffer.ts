// Software framebuffer in ImageData's little-endian RGBA layout (0xAABBGGRR per pixel).
import { FOV_WIDE, INTERNAL_H, INTERNAL_W } from '@zoom3d/shared';

/** Desktop's horizontal field of view; touch devices pick theirs from the screen's aspect (mobile spec §2.2). */
export const DEFAULT_FOV = FOV_WIDE;

export interface Framebuffer {
  width: number;
  height: number;
  pixels: Uint32Array;
  /** Perpendicular wall distance per column, for the sprite pass. */
  zbuffer: Float64Array;
  /** Horizontal field of view, radians: every projection onto this buffer uses it. */
  fov: number;
}

export function createFramebuffer(width = INTERNAL_W, height = INTERNAL_H, fov = DEFAULT_FOV): Framebuffer {
  return { width, height, pixels: new Uint32Array(width * height), zbuffer: new Float64Array(width), fov };
}

/** Packs an opaque colour as 0xFFBBGGRR. */
export function rgb(r: number, g: number, b: number): number {
  return ((0xff << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}
