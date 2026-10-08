// Software framebuffer in ImageData's little-endian RGBA layout (0xAABBGGRR per pixel).
import { INTERNAL_H, INTERNAL_W } from '@zoom3d/shared';

export interface Framebuffer {
  width: number;
  height: number;
  pixels: Uint32Array;
  /** Perpendicular wall distance per column, for the sprite pass. */
  zbuffer: Float64Array;
}

export function createFramebuffer(width = INTERNAL_W, height = INTERNAL_H): Framebuffer {
  return { width, height, pixels: new Uint32Array(width * height), zbuffer: new Float64Array(width) };
}

/** Packs an opaque colour as 0xFFBBGGRR. */
export function rgb(r: number, g: number, b: number): number {
  return ((0xff << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}
