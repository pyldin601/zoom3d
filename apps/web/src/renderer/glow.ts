// Avatars as lights: each disc glows like a small screen, its face's average colour, lighting the floor and walls
// around it as it moves. Drawn per frame; an avatar's glow casts no shadows: its reach is short. A portal's glow
// never moves, so its shadows are baked with the room's portals-on lighting (`GlowShadow`).
import type { Portal, Portals } from '@zoom3d/shared';
import { PORTAL_PINK } from '../game/portal-pulse';
import { EYE_HEIGHT } from './camera';

/**
 * A glowing disc at (x, y), centred at eye height: light r, g, b (1 = a full lamp's brightness), reaching `reach`
 * tiles. With a `cut`, it lights only the side of that plane it stands on; with a `shadow`, only as much as a point
 * sees of it past the walls; with a `cone`, only what lies ahead of it.
 */
export interface Glow {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  reach: number;
  cut: GlowCut | null;
  shadow: GlowShadow | null;
  cone: GlowCone | null;
}

/**
 * Seen from above, the glow's light leaves along unit direction (dx, dy): full where the cosine of a point's angle
 * off it is at least `cosFull`, none at `cosEdge` or less, blended between.
 */
export interface GlowCone {
  dx: number;
  dy: number;
  cosEdge: number;
  cosFull: number;
}

/** A vertical plane through (cx, cy) with normal (nx, ny): points on it or on its +n side get none of the glow. */
export interface GlowCut {
  cx: number;
  cy: number;
  nx: number;
  ny: number;
}

/**
 * How much of a glow's disc each floor cell around it sees past the walls, 0..255: a grid of `across` × `down` cells,
 * `sub` per tile, from cell (`firstCol`, `firstRow`) of the map's grid. Outside it, nothing.
 */
export interface GlowShadow {
  sub: number;
  firstCol: number;
  firstRow: number;
  across: number;
  down: number;
  seen: Uint8Array;
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
/** A portal's glow at the top of its pulse, as a share of a full lamp's light. */
export const PORTAL_GLOW_STRENGTH = 0.9;
/** How far in front of its doorway's plane a portal's glow stands: just past the door frame, so the frame faces it. */
const PORTAL_GLOW_OFFSET = 0.6;
/**
 * A wall sample's shadow is looked up this far in front of it (tiles), in the floor cell before the wall: the hit
 * point itself may round into the wall's own tile.
 */
const IN_FRONT_OF_WALL = 1e-3;
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
 * How much of glow `g` reaches the surface at (x, y, z) facing (nx, ny, nz): a lamp-like falloff to nothing at its
 * reach, times how squarely the surface faces the disc, how much of it the surface sees and how far inside its cone
 * the surface lies. 0..1, before the glow's colour.
 */
export function glowLight(g: Glow, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  if (hiddenByCut(g, x, y)) {
    return 0;
  }
  const dx = g.x - x;
  const dy = g.y - y;
  const dz = EYE_HEIGHT - z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const reach2 = g.reach * g.reach;
  if (d2 >= reach2) {
    return 0;
  }
  const facing = dx * nx + dy * ny + dz * nz;
  if (facing <= 0) {
    return 0;
  }
  const seen = g.shadow ? shadowSeen(g.shadow, x + nx * IN_FRONT_OF_WALL, y + ny * IN_FRONT_OF_WALL) : 1;
  if (seen === 0) {
    return 0;
  }
  const ahead = coneFactor(g, x, y);
  if (ahead === 0) {
    return 0;
  }
  const k = 1 - d2 / reach2;
  return k * k * (facing / Math.sqrt(d2)) * seen * ahead;
}

/** How far inside `g`'s cone (x, y) lies, seen from above: 0 outside, 1 well inside, and 1 for a glow without one. */
export function coneFactor(g: Glow, x: number, y: number): number {
  const { cone } = g;
  if (cone === null) {
    return 1;
  }
  const dx = x - g.x;
  const dy = y - g.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) {
    return 1;
  }
  const cos = (dx * cone.dx + dy * cone.dy) / d;
  if (cos <= cone.cosEdge) {
    return 0;
  }
  if (cos >= cone.cosFull) {
    return 1;
  }
  const t = (cos - cone.cosEdge) / (cone.cosFull - cone.cosEdge);
  return t * t * (3 - 2 * t);
}

/** How much of its glow the floor cell holding (x, y) sees, 0..1. */
function shadowSeen(shadow: GlowShadow, x: number, y: number): number {
  const col = Math.floor(x * shadow.sub) - shadow.firstCol;
  const row = Math.floor(y * shadow.sub) - shadow.firstRow;
  if (col < 0 || col >= shadow.across || row < 0 || row >= shadow.down) {
    return 0;
  }
  return (shadow.seen[row * shadow.across + col] as number) / 255;
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
      g = { x: 0, y: 0, r: 0, g: 0, b: 0, reach: GLOW_RADIUS, cut: null, shadow: null, cone: null };
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
   * swells, shadowed by `shadows` (one per portal, `Lighting.portalGlowSeen`) when given. Empty without portals.
   */
  update(portals: Portals | null, pulse: number, shadows: readonly GlowShadow[] | null): readonly Glow[];
}

/** A portal's glow, without its colour: in front of the portal's doorway, cut at its plane. */
export type PortalGlow = Glow & { cut: GlowCut };

export function newPortalGlow(): PortalGlow {
  return {
    x: 0,
    y: 0,
    r: 0,
    g: 0,
    b: 0,
    reach: GLOW_RADIUS,
    cut: { cx: 0, cy: 0, nx: 0, ny: 0 },
    shadow: null,
    cone: null,
  };
}

/** Moves `g` in front of `portal`'s doorway and cuts it at the doorway's plane. */
export function placePortalGlow(g: PortalGlow, portal: Portal): void {
  g.cut.cx = portal.cx;
  g.cut.cy = portal.cy;
  g.cut.nx = portal.nx;
  g.cut.ny = portal.ny;
  g.x = portal.cx - PORTAL_GLOW_OFFSET * portal.nx;
  g.y = portal.cy - PORTAL_GLOW_OFFSET * portal.ny;
}

const NO_PORTALS: Portals['list'] = [];

export function createPortalGlows(): PortalGlows {
  const pool: PortalGlow[] = [];
  const glows: Glow[] = [];
  return {
    update(portals, pulse, shadows) {
      const strength = PORTAL_GLOW_STRENGTH * (0.25 + 0.75 * pulse);
      let count = 0;
      for (const portal of portals?.list ?? NO_PORTALS) {
        let g = pool.at(count);
        if (!g) {
          g = newPortalGlow();
          pool.push(g);
        }
        placePortalGlow(g, portal);
        g.shadow = shadows?.at(count) ?? null;
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
