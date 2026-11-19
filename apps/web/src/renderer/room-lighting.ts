// The room's lamp light. The plain table (about 125 ms) is baked on first use rather than at page load, so the landing
// page never waits for it. A room's portals-on table (about 270 ms) depends on its wiring, so it is baked per room id:
// in an idle moment while the room's lobby is open, so the Join click doesn't stall, or at the latest in joinRoom. So
// it is ready before any welcome can turn portals on, and the swap on Y never waits. The dark table (about 20 ms), for a
// portal sequence's blackout, is baked with it. Realistic portals (D38) have their own pair of tables, about 290 ms,
// baked only once someone chooses that look, so classic viewers never pay for it.
import { type GameMap, type Portals, photonPortals } from '@zoom3d/shared';
import { bakeLighting, bakePortalLighting, corridorLights, type Lighting } from './lighting';
import { averageColour } from './textures';
import { CEILING, FLOOR } from './walls';

/** Ambient light is bounce light: what the lamps' lit surfaces throw back, over a bare minimum so no room is black. */
const BARE_AMBIENT = 0.08;
/** How much of the light the lamps' lit surfaces throw back comes back as ambient (see `Bounce`). */
const BOUNCE_STRENGTH = 3.5;

/** Unlit (`?lights=off`), the room has no lighting: null. */
export function bakeRoomLightingOnce(map: GameMap, textures: Uint32Array[], lit: boolean): () => Lighting | null {
  let baked: { lighting: Lighting | null } | null = null;
  return () => {
    baked ??= {
      lighting: lit
        ? bakeLighting(map, corridorLights(map), BARE_AMBIENT, FLOOR, CEILING, {
            wallColours: textures.map((tex) => (tex.length ? averageColour(tex) : 0)),
            strength: BOUNCE_STRENGTH,
          })
        : null,
    };
    return baked.lighting;
  };
}

export interface RoomLighting {
  /** The room's portal wiring, which the portals-on table was baked for. */
  readonly portals: Portals;
  /** The same doorways as realistic portals show them (`photonPortals`). */
  readonly photon: Portals;
  /** Bakes the realistic tables, once; later calls do nothing. */
  bakeRealistic(): void;
  /** Whether `lighting(photon, …)` may be asked for: baked, or nothing to bake in an unlit room. */
  realisticReady(): boolean;
  /**
   * The table for what the eye sees: `sight` is the set in view (`portals`, `photon`, or null with portals off), or
   * the blackout of that set while `dark`. Null when the room is unlit.
   */
  lighting(sight: Portals | null, dark: boolean): Lighting | null;
}

/**
 * The portals-on and dark tables are baked here, at once, so they are ready before the first welcome can turn portals
 * on or a portal sequence can put the lamps out.
 */
export function createRoomLighting(plain: Lighting | null, portals: Portals): RoomLighting {
  const photon = photonPortals(portals);
  const classic = bakeWith(plain, portals);
  let realistic: ReturnType<typeof bakeWith> | null = plain === null ? { lit: null, dark: null } : null;
  return {
    portals,
    photon,
    bakeRealistic() {
      realistic ??= bakeWith(plain, photon);
    },
    realisticReady: () => realistic !== null,
    lighting: (sight, dark) => {
      if (sight === photon) {
        if (realistic === null) {
          throw new Error('realistic portal lighting asked for before it was baked');
        }
        return dark ? realistic.dark : realistic.lit;
      }
      if (dark) {
        return classic.dark;
      }
      return sight === null ? plain : classic.lit;
    },
  };
}

/** A portals-on table for `portals`, and its blackout. */
function bakeWith(plain: Lighting | null, portals: Portals): { lit: Lighting | null; dark: Lighting | null } {
  const lit = plain && bakePortalLighting(plain, portals, FLOOR, CEILING);
  return { lit, dark: lit && blackedOut(lit) };
}

/** Every lamp out, with no ambient or bounce light, but the portal glows still cast their shadows. */
function blackedOut(withPortals: Lighting): Lighting {
  const unlit = bakeLighting(withPortals.map, [], 0, FLOOR, CEILING);
  return { ...unlit, portals: withPortals.portals, portalGlowSeen: withPortals.portalGlowSeen };
}

/** Only the latest room id is kept: a page is in one room at a time. */
export function roomLightingByRoom(
  plain: () => Lighting | null,
  wire: (roomId: string) => Portals
): (roomId: string) => RoomLighting {
  let latest: { roomId: string; room: RoomLighting } | null = null;
  return (roomId) => {
    if (latest?.roomId !== roomId) {
      latest = { roomId, room: createRoomLighting(plain(), wire(roomId)) };
    }
    return latest.room;
  };
}
