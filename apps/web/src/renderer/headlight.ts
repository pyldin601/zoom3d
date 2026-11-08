// A ridden scooter's headlight (scooter headlight spec): a warm white cone of light ahead of the scooter, along its
// heading, blocked by walls. Like the lighter's, its shadow table is refilled only when the lamp enters another floor
// cell or the portals switch: the table covers the whole disc round the lamp, and the cone only picks from it. The
// lamp sits ahead of the rider, so turning on the spot carries it through a few cells too (about 19 a full turn).
// Like a projector headlight's lens, it spreads its colours at the edge (owner, 2026-11-08). Most of the light is one
// white cone with a soft edge. A faint share is split into red, green and blue cones a degree apart, blue widest, so a
// thin blue-violet line runs just past the white edge, with a cool tint just inside. Nested cones can't put a warm band
// inside a blue one: the widest colour lights everything within it.
import type { GameMap, Portals } from '@zoom3d/shared';
import type { Glow, GlowCone, GlowShadow } from './glow';
import { FLOOR_SUB, fillGlowSeen, newGlowShadow } from './lighting';

/** How far a headlight's light reaches (tiles). */
export const HEADLIGHT_REACH = 5;
/** A headlight's light at the lamp, as a share of a full lamp's: the lighter's, as a start to tune by riding. */
export const HEADLIGHT_STRENGTH = 1.5;
/** Linear colour of the lamp: a warm white, near the lamp voxel's. */
export const HEADLIGHT_COLOUR = { r: 1, g: 0.9, b: 0.7 };
/** Half the cone's width: past it, no light. The lighter's cone, before it went all round (D31). */
export const HEADLIGHT_CONE_HALF_RAD = (35 * Math.PI) / 180;
/** The outermost part of the white cone's half-width, over which its light fades out; soft, as 3° was too sharp. */
export const HEADLIGHT_CONE_FADE_RAD = (8 * Math.PI) / 180;
/** How far apart the fringe's red, green and blue edges are. */
export const HEADLIGHT_FRINGE_RAD = (1 * Math.PI) / 180;
/** Each fringe colour fades out over this much of its half-width: a thin line, not a band. */
export const HEADLIGHT_FRINGE_FADE_RAD = (2 * Math.PI) / 180;
/** The share of the lamp's light split into the coloured fringe; the rest stays white. A hint, not a tint. */
export const HEADLIGHT_FRINGE_SHARE = 0.2;
/** How far ahead of its rider the lamp sits: about at the stem. */
export const HEADLIGHT_AHEAD_TILES = 0.3;

const WHITE = 1 - HEADLIGHT_FRINGE_SHARE;
const FRINGE = HEADLIGHT_FRINGE_SHARE;
/** The white beam, then the fringe's red, green and blue: each one's colour, half-width and fade. */
const CHANNELS = [
  {
    r: HEADLIGHT_COLOUR.r * WHITE,
    g: HEADLIGHT_COLOUR.g * WHITE,
    b: HEADLIGHT_COLOUR.b * WHITE,
    half: HEADLIGHT_CONE_HALF_RAD,
    fade: HEADLIGHT_CONE_FADE_RAD,
  },
  {
    r: HEADLIGHT_COLOUR.r * FRINGE,
    g: 0,
    b: 0,
    half: HEADLIGHT_CONE_HALF_RAD - 0.5 * HEADLIGHT_FRINGE_RAD,
    fade: HEADLIGHT_FRINGE_FADE_RAD,
  },
  {
    r: 0,
    g: HEADLIGHT_COLOUR.g * FRINGE,
    b: 0,
    half: HEADLIGHT_CONE_HALF_RAD + 0.5 * HEADLIGHT_FRINGE_RAD,
    fade: HEADLIGHT_FRINGE_FADE_RAD,
  },
  {
    r: 0,
    g: 0,
    b: HEADLIGHT_COLOUR.b * FRINGE,
    half: HEADLIGHT_CONE_HALF_RAD + 1.5 * HEADLIGHT_FRINGE_RAD,
    fade: HEADLIGHT_FRINGE_FADE_RAD,
  },
] as const;

/** Someone riding: who (to tell their tables apart), where they stand and which way the scooter faces. */
export interface HeadlightSource {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** A frame's headlight glows, in objects reused from frame to frame. */
export interface HeadlightGlows {
  /**
   * Four glows per source in order (white, then the fringe's red, green and blue), shadowed on `map` with `portals`
   * (the room's, while on).
   */
  update(sources: Iterable<HeadlightSource>, map: GameMap, portals: Portals | null): readonly Glow[];
}

type ChannelGlow = Glow & { cone: GlowCone; shadow: GlowShadow };

/** One rider's white and fringe glows, their one shadow table, and the floor cell and portals it was filled for. */
interface Lamp {
  glows: readonly ChannelGlow[];
  shadow: GlowShadow;
  cellX: number;
  cellY: number;
  portals: Portals | null;
  stamp: number;
}

export function createHeadlightGlows(): HeadlightGlows {
  const lamps = new Map<string, Lamp>();
  const glows: Glow[] = [];
  let stamp = 0;

  const lampOf = (key: string): Lamp => {
    let lamp = lamps.get(key);
    if (!lamp) {
      const shadow = newGlowShadow(HEADLIGHT_REACH);
      const glows = CHANNELS.map((channel) => {
        const cosEdge = Math.cos(channel.half);
        const cosFull = Math.cos(channel.half - channel.fade);
        return {
          x: 0,
          y: 0,
          r: channel.r * HEADLIGHT_STRENGTH,
          g: channel.g * HEADLIGHT_STRENGTH,
          b: channel.b * HEADLIGHT_STRENGTH,
          reach: HEADLIGHT_REACH,
          cut: null,
          shadow,
          cone: { dx: 1, dy: 0, cosEdge, cosFull },
        };
      });
      // A cell no lamp is in, so the first update fills the table.
      lamp = { glows, shadow, cellX: -1, cellY: -1, portals: null, stamp: 0 };
      lamps.set(key, lamp);
    }
    return lamp;
  };

  return {
    update(sources, map, portals) {
      stamp++;
      let count = 0;
      for (const source of sources) {
        // A rider missing from an update is forgotten, so on return they get a new table.
        const lamp = lampOf(source.key);
        lamp.stamp = stamp;
        const dx = Math.cos(source.angle);
        const dy = Math.sin(source.angle);
        const x = source.x + dx * HEADLIGHT_AHEAD_TILES;
        const y = source.y + dy * HEADLIGHT_AHEAD_TILES;
        for (const glow of lamp.glows) {
          glow.x = x;
          glow.y = y;
          glow.cone.dx = dx;
          glow.cone.dy = dy;
          // Written by index and trimmed after, as in createLighterGlows.
          glows[count++] = glow;
        }
        const cellX = Math.floor(x * FLOOR_SUB);
        const cellY = Math.floor(y * FLOOR_SUB);
        if (cellX !== lamp.cellX || cellY !== lamp.cellY || portals !== lamp.portals) {
          fillGlowSeen(map, portals, x, y, HEADLIGHT_REACH, null, lamp.shadow);
          lamp.cellX = cellX;
          lamp.cellY = cellY;
          lamp.portals = portals;
        }
      }
      glows.length = count;
      for (const [key, lamp] of lamps) {
        if (lamp.stamp !== stamp) {
          lamps.delete(key);
        }
      }
      return glows;
    },
  };
}
