// A ridden scooter's headlight (scooter headlight spec): a warm white cone of light ahead of the scooter, along its
// heading, blocked by walls. Like the lighter's, its shadow table is refilled only when the lamp enters another floor
// cell or the portals switch: the table covers the whole disc round the lamp, and the cone only picks from it. The
// lamp sits ahead of the rider, so turning on the spot carries it through a few cells too (about 19 a full turn).
// Like a real lens, it spreads its colours (owner, 2026-11-08): each lamp is a red, a green and a blue glow, red a
// little wider and blue a little narrower, so the middle is the lamp's white and the edge goes yellow, then red.
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
/** The outermost part of the cone's half-width, over which its light fades out. */
export const HEADLIGHT_CONE_FADE_RAD = (5 * Math.PI) / 180;
/** Red's cone is this much wider than green's, and blue's this much narrower: how wide the coloured edge is. */
export const HEADLIGHT_FRINGE_RAD = (5 * Math.PI) / 180;
/** How far ahead of its rider the lamp sits: about at the stem. */
export const HEADLIGHT_AHEAD_TILES = 0.3;

/** Red, green and blue: each colour's share of the lamp and how much wider than green its cone is. */
const CHANNELS = [
  { r: HEADLIGHT_COLOUR.r, g: 0, b: 0, wider: HEADLIGHT_FRINGE_RAD },
  { r: 0, g: HEADLIGHT_COLOUR.g, b: 0, wider: 0 },
  { r: 0, g: 0, b: HEADLIGHT_COLOUR.b, wider: -HEADLIGHT_FRINGE_RAD },
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
  /** Three glows per source in order (red, green, blue), shadowed on `map` with `portals` (the room's, while on). */
  update(sources: Iterable<HeadlightSource>, map: GameMap, portals: Portals | null): readonly Glow[];
}

type ChannelGlow = Glow & { cone: GlowCone; shadow: GlowShadow };

/** One rider's red, green and blue glows, their one shadow table, and the floor cell and portals it was filled for. */
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
        const half = HEADLIGHT_CONE_HALF_RAD + channel.wider;
        const cosEdge = Math.cos(half);
        const cosFull = Math.cos(half - HEADLIGHT_CONE_FADE_RAD);
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
