// Avatars as lights: each disc glows like a small screen, its face's average colour, lighting the floor and walls
// around it as it moves. Drawn per frame, no shadows: its reach is short.
import { EYE_HEIGHT } from './camera';

/** A glowing disc at (x, y), centred at eye height: light r, g, b (1 = a full lamp's brightness). */
export interface Glow {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

/** How far a disc's glow reaches (tiles). */
export const GLOW_RADIUS = 2.5;
/** A white face glows this much of a full lamp's light at the disc. */
export const GLOW_STRENGTH = 0.6;
/** Faces are averaged on this many texels per side, not all 256² of them. */
const GLOW_SAMPLES = 16;

/** Fills `out` with the glow of a disc at (x, y) showing `face` (or, without one, its ring `colour`). */
export function glowOf(x: number, y: number, face: Uint32Array | null, colour: number, out: Glow): void {
  out.x = x;
  out.y = y;
  let r = colour & 0xff;
  let g = (colour >>> 8) & 0xff;
  let b = (colour >>> 16) & 0xff;
  if (face) {
    const size = Math.round(Math.sqrt(face.length));
    const step = size / GLOW_SAMPLES;
    r = 0;
    g = 0;
    b = 0;
    for (let j = 0; j < GLOW_SAMPLES; j++) {
      for (let i = 0; i < GLOW_SAMPLES; i++) {
        const c = face[((j * step + step / 2) | 0) * size + ((i * step + step / 2) | 0)] as number;
        r += c & 0xff;
        g += (c >>> 8) & 0xff;
        b += (c >>> 16) & 0xff;
      }
    }
    const n = GLOW_SAMPLES * GLOW_SAMPLES;
    r /= n;
    g /= n;
    b /= n;
  }
  out.r = (r / 255) * GLOW_STRENGTH;
  out.g = (g / 255) * GLOW_STRENGTH;
  out.b = (b / 255) * GLOW_STRENGTH;
}

/**
 * How much of glow `g` reaches the surface at (x, y, z) facing (nx, ny, nz): a lamp-like falloff to nothing at
 * GLOW_RADIUS, times how squarely the surface faces the disc. 0..1, before the glow's colour.
 */
export function glowLight(g: Glow, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  const dx = g.x - x;
  const dy = g.y - y;
  const dz = EYE_HEIGHT - z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const reach2 = GLOW_RADIUS * GLOW_RADIUS;
  if (d2 >= reach2) {
    return 0;
  }
  const facing = dx * nx + dy * ny + dz * nz;
  if (facing <= 0) {
    return 0;
  }
  const k = 1 - d2 / reach2;
  return k * k * (facing / Math.sqrt(d2));
}
