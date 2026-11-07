// A ridden scooter's headlight (scooter headlight spec): a warm white cone of light ahead of the scooter, along its
// heading, blocked by walls. Like the lighter's, its shadow table is refilled only when the lamp enters another floor
// cell or the portals switch, never on a turn: the table covers the whole disc round the lamp, and the cone only picks
// from it.
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
export const HEADLIGHT_CONE_FADE_RAD = (10 * Math.PI) / 180;
/** How far ahead of its rider the lamp sits: about at the stem. */
export const HEADLIGHT_AHEAD_TILES = 0.3;

const CONE_COS_EDGE = Math.cos(HEADLIGHT_CONE_HALF_RAD);
const CONE_COS_FULL = Math.cos(HEADLIGHT_CONE_HALF_RAD - HEADLIGHT_CONE_FADE_RAD);

/** Someone riding: who (to tell their tables apart), where they stand and which way the scooter faces. */
export interface HeadlightSource {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** A frame's headlight glows, in objects reused from frame to frame. */
export interface HeadlightGlows {
  /** One glow per source in order, shadowed on `map` with `portals` (the room's, while on). */
  update(sources: Iterable<HeadlightSource>, map: GameMap, portals: Portals | null): readonly Glow[];
}

/** One rider's glow and the floor cell and portals its shadow table was filled for. */
interface Lamp {
  glow: Glow & { cone: GlowCone; shadow: GlowShadow };
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
      const cone = { dx: 1, dy: 0, cosEdge: CONE_COS_EDGE, cosFull: CONE_COS_FULL };
      const glow = {
        x: 0,
        y: 0,
        r: HEADLIGHT_COLOUR.r * HEADLIGHT_STRENGTH,
        g: HEADLIGHT_COLOUR.g * HEADLIGHT_STRENGTH,
        b: HEADLIGHT_COLOUR.b * HEADLIGHT_STRENGTH,
        reach: HEADLIGHT_REACH,
        cut: null,
        shadow,
        cone,
      };
      // A cell no lamp is in, so the first update fills the table.
      lamp = { glow, cellX: -1, cellY: -1, portals: null, stamp: 0 };
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
        const { glow } = lamp;
        const dx = Math.cos(source.angle);
        const dy = Math.sin(source.angle);
        glow.x = source.x + dx * HEADLIGHT_AHEAD_TILES;
        glow.y = source.y + dy * HEADLIGHT_AHEAD_TILES;
        glow.cone.dx = dx;
        glow.cone.dy = dy;
        const cellX = Math.floor(glow.x * FLOOR_SUB);
        const cellY = Math.floor(glow.y * FLOOR_SUB);
        if (cellX !== lamp.cellX || cellY !== lamp.cellY || portals !== lamp.portals) {
          fillGlowSeen(map, portals, glow.x, glow.y, HEADLIGHT_REACH, null, glow.shadow);
          lamp.cellX = cellX;
          lamp.cellY = cellY;
          lamp.portals = portals;
        }
        // Written by index and trimmed after, as in createLighterGlows.
        glows[count++] = glow;
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
