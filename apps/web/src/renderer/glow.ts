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

/** A disc that glows: where it stands, and its face or, without one, its ring colour. */
export interface GlowSource {
  readonly x: number;
  readonly y: number;
  readonly face: Uint32Array | null;
  readonly color: number;
}

/** How far a disc's glow reaches (tiles). */
export const GLOW_RADIUS = 2.5;
/** A white face glows this much of a full lamp's light at the disc. */
export const GLOW_STRENGTH = 0.6;
/** Faces are averaged on this many texels per side, not all 256² of them. */
const GLOW_SAMPLES = 16;

/** A colour's r, g, b, 0..255, as averageFace and unpackColour return it: a reused object. */
const channels = { r: 0, g: 0, b: 0 };

/** Fills `out` with the glow of `source`: its face's average colour, or its ring colour. */
export function glowOf(source: GlowSource, out: Glow): void {
  const colour = source.face ? averageFace(source.face) : unpackColour(source.color);
  out.x = source.x;
  out.y = source.y;
  out.r = (colour.r / 255) * GLOW_STRENGTH;
  out.g = (colour.g / 255) * GLOW_STRENGTH;
  out.b = (colour.b / 255) * GLOW_STRENGTH;
}

/** The face's average colour, from GLOW_SAMPLES² texels spread evenly over it. */
function averageFace(face: Uint32Array): typeof channels {
  const size = Math.round(Math.sqrt(face.length));
  const step = size / GLOW_SAMPLES;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let j = 0; j < GLOW_SAMPLES; j++) {
    for (let i = 0; i < GLOW_SAMPLES; i++) {
      const c = face[((j * step + step / 2) | 0) * size + ((i * step + step / 2) | 0)] as number;
      r += c & 0xff;
      g += (c >>> 8) & 0xff;
      b += (c >>> 16) & 0xff;
    }
  }
  const n = GLOW_SAMPLES * GLOW_SAMPLES;
  channels.r = r / n;
  channels.g = g / n;
  channels.b = b / n;
  return channels;
}

function unpackColour(colour: number): typeof channels {
  channels.r = colour & 0xff;
  channels.g = (colour >>> 8) & 0xff;
  channels.b = (colour >>> 16) & 0xff;
  return channels;
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

/** A frame's avatar glows, in objects reused from frame to frame. */
export interface AvatarGlows {
  /** Recomputes the list: one glow per disc in order, then `self`'s when it isn't null. */
  update(discs: readonly GlowSource[], self: GlowSource | null): readonly Glow[];
}

export function createAvatarGlows(): AvatarGlows {
  /** Every glow object made so far; the list hands out the first `n` each frame. */
  const pool: Glow[] = [];
  const glows: Glow[] = [];
  let count = 0;
  const add = (source: GlowSource) => {
    let g = pool.at(count);
    if (!g) {
      g = { x: 0, y: 0, r: 0, g: 0, b: 0 };
      pool.push(g);
    }
    glowOf(source, g);
    // Written by index and trimmed after: `length = 0` would make V8 drop the array's storage every frame.
    glows[count++] = g;
  };
  return {
    update(discs, self) {
      count = 0;
      for (const disc of discs) {
        add(disc);
      }
      if (self) {
        add(self);
      }
      glows.length = count;
      return glows;
    },
  };
}
