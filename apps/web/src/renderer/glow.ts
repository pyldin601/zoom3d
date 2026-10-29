// Avatars as lights: each disc glows like a small screen, its face's average colour, lighting the floor and walls
// around it as it moves. Drawn per frame, no shadows: its reach is short.
import type { Portals } from '@zoom3d/shared';
import { PORTAL_PINK } from '../game/portal-pulse';
import { EYE_HEIGHT } from './camera';

/**
 * A glowing disc at (x, y), centred at eye height: light r, g, b (1 = a full lamp's brightness). With a `cut`, it
 * lights only the side of that plane it stands on.
 */
export interface Glow {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  cut: GlowCut | null;
}

/** A vertical plane through (cx, cy) with normal (nx, ny): points on it or on its +n side get none of the glow. */
export interface GlowCut {
  cx: number;
  cy: number;
  nx: number;
  ny: number;
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
/** A portal's glow at the top of its pulse, as a share of a full lamp's light. Tuned by eye (D29). */
export const PORTAL_GLOW_STRENGTH = 0.5;
/** How far in front of its doorway's plane a portal's glow stands: just past the door frame, so the frame faces it. */
const PORTAL_GLOW_OFFSET = 0.6;
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
  if (hiddenByCut(g, x, y)) {
    return 0;
  }
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

/** Whether `g`'s cut keeps all of its light off (x, y): false for a glow without one. */
export function hiddenByCut(g: Glow, x: number, y: number): boolean {
  const { cut } = g;
  return cut !== null && (x - cut.cx) * cut.nx + (y - cut.cy) * cut.ny >= 0;
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
      g = { x: 0, y: 0, r: 0, g: 0, b: 0, cut: null };
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

/** A frame's portal glows, in objects reused from frame to frame. */
export interface PortalGlows {
  /**
   * One pink glow per portal, in front of its doorway and lighting only that side of it, brighter as `pulse` (0..1)
   * swells. Empty without portals.
   */
  update(portals: Portals | null, pulse: number): readonly Glow[];
}

const NO_PORTALS: Portals['list'] = [];

export function createPortalGlows(): PortalGlows {
  const pool: (Glow & { cut: GlowCut })[] = [];
  const glows: Glow[] = [];
  return {
    update(portals, pulse) {
      const strength = PORTAL_GLOW_STRENGTH * (0.25 + 0.75 * pulse);
      let count = 0;
      for (const portal of portals?.list ?? NO_PORTALS) {
        let g = pool.at(count);
        if (!g) {
          g = { x: 0, y: 0, r: 0, g: 0, b: 0, cut: { cx: 0, cy: 0, nx: 0, ny: 0 } };
          pool.push(g);
        }
        g.cut.cx = portal.cx;
        g.cut.cy = portal.cy;
        g.cut.nx = portal.nx;
        g.cut.ny = portal.ny;
        g.x = portal.cx - PORTAL_GLOW_OFFSET * portal.nx;
        g.y = portal.cy - PORTAL_GLOW_OFFSET * portal.ny;
        g.r = PORTAL_PINK.r * strength;
        g.g = PORTAL_PINK.g * strength;
        g.b = PORTAL_PINK.b * strength;
        // Written by index and trimmed after, as in createAvatarGlows.
        glows[count++] = g;
      }
      glows.length = count;
      return glows;
    },
  };
}
