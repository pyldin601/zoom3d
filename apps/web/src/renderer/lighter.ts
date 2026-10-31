// A held lighter as a light (lighter spec §3.2): a warm glow that flickers, thrown in a cone along its holder's facing
// and blocked by walls. Its shadow table is refilled only when the holder steps into another floor cell or the portals
// switch, never on a turn: the table covers the whole disc around the flame, and the cone only picks from it.
import type { GameMap, Portals } from '@zoom3d/shared';
import type { Glow, GlowCone, GlowShadow } from './glow';
import { FLOOR_SUB, fillGlowSeen, newGlowShadow } from './lighting';

/** How far a lighter's light reaches (tiles). */
export const LIGHTER_REACH = 4;
/** A lighter's light at the flame, as a share of a full lamp's: at 0.8 (the spec's first guess) its pool on the floor hardly showed. */
export const LIGHTER_STRENGTH = 3;
/** Linear colour of a lighter's flame. */
export const LIGHTER_COLOUR = { r: 1, g: 0.55, b: 0.2 };
/** Half the cone's width: past it, no light. */
export const LIGHTER_CONE_HALF_RAD = (35 * Math.PI) / 180;
/** The outermost part of the cone's half-width, over which its light fades out. */
export const LIGHTER_CONE_FADE_RAD = (10 * Math.PI) / 180;
/** The flicker moves the light up to this share either way. */
export const LIGHTER_FLICKER = 0.1;

const CONE_COS_EDGE = Math.cos(LIGHTER_CONE_HALF_RAD);
const CONE_COS_FULL = Math.cos(LIGHTER_CONE_HALF_RAD - LIGHTER_CONE_FADE_RAD);
/** Three sines at unrelated rates (Hz) never line up into a visible beat; their weights add up to 1. */
const FLICKER_WAVES = [
  { hz: 5.3, weight: 0.5 },
  { hz: 8.1, weight: 0.3 },
  { hz: 11.7, weight: 0.2 },
] as const;

/** Someone holding a lighter: who (to tell their flicker and table apart), where and which way they face. */
export interface LighterSource {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** A frame's lighter glows, in objects reused from frame to frame. */
export interface LighterGlows {
  /** One glow per source in order, shadowed on `map` with `portals` (the room's, while on), flickering at `seconds`. */
  update(sources: Iterable<LighterSource>, map: GameMap, portals: Portals | null, seconds: number): readonly Glow[];
}

/** One holder's glow and the floor cell and portals its shadow table was filled for. */
interface Held {
  glow: Glow & { cone: GlowCone; shadow: GlowShadow };
  phase: number;
  cellX: number;
  cellY: number;
  portals: Portals | null;
  stamp: number;
}

export function createLighterGlows(): LighterGlows {
  const held = new Map<string, Held>();
  const glows: Glow[] = [];
  let stamp = 0;

  const heldBy = (key: string): Held => {
    let entry = held.get(key);
    if (!entry) {
      const cone = { dx: 1, dy: 0, cosEdge: CONE_COS_EDGE, cosFull: CONE_COS_FULL };
      const shadow = newGlowShadow(LIGHTER_REACH);
      const glow = { x: 0, y: 0, r: 0, g: 0, b: 0, reach: LIGHTER_REACH, cut: null, shadow, cone };
      // A cell no one stands in, so the first update fills the table.
      entry = { glow, phase: phaseOf(key), cellX: -1, cellY: -1, portals: null, stamp: 0 };
      held.set(key, entry);
    }
    return entry;
  };

  return {
    update(sources, map, portals, seconds) {
      stamp++;
      let count = 0;
      for (const source of sources) {
        // A holder missing from an update is forgotten, so on return they get a new table.
        const entry = heldBy(source.key);
        entry.stamp = stamp;
        const { glow } = entry;
        glow.x = source.x;
        glow.y = source.y;
        glow.cone.dx = Math.cos(source.angle);
        glow.cone.dy = Math.sin(source.angle);
        const brightness = LIGHTER_STRENGTH * flicker(seconds, entry.phase);
        glow.r = LIGHTER_COLOUR.r * brightness;
        glow.g = LIGHTER_COLOUR.g * brightness;
        glow.b = LIGHTER_COLOUR.b * brightness;
        const cellX = Math.floor(source.x * FLOOR_SUB);
        const cellY = Math.floor(source.y * FLOOR_SUB);
        if (cellX !== entry.cellX || cellY !== entry.cellY || portals !== entry.portals) {
          fillGlowSeen(map, portals, source.x, source.y, LIGHTER_REACH, null, glow.shadow);
          entry.cellX = cellX;
          entry.cellY = cellY;
          entry.portals = portals;
        }
        // Written by index and trimmed after, as in createAvatarGlows.
        glows[count++] = glow;
      }
      glows.length = count;
      for (const [key, entry] of held) {
        if (entry.stamp !== stamp) {
          held.delete(key);
        }
      }
      return glows;
    },
  };
}

/** The flicker of the lighter held by `key` at `seconds`: 1 ± LIGHTER_FLICKER. */
export function lighterFlicker(seconds: number, key: string): number {
  return flicker(seconds, phaseOf(key));
}

function flicker(seconds: number, phase: number): number {
  let wave = 0;
  for (const { hz, weight } of FLICKER_WAVES) {
    wave += weight * Math.sin(2 * Math.PI * hz * seconds + phase * hz);
  }
  return 1 + LIGHTER_FLICKER * wave;
}

/** A phase in [0, 2π) from the key's characters, so each holder's flame flickers on its own. */
function phaseOf(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) / 2 ** 32) * 2 * Math.PI;
}
