// The room's lamp light. The plain table is baked on first use (about 125 ms) rather than at page load, so the landing
// page never waits for it. The portals-on table (about 270 ms) is baked in joinRoom, before the connection starts, so
// it is ready before any welcome can turn portals on and the swap on Y never waits.
import type { GameMap, Portals } from '@zoom3d/shared';
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
  /** The table for a room whose portals are on or off. Null when the room is unlit. */
  lighting(portalsOn: boolean): Lighting | null;
}

/** The portals-on table is baked here, at once, so it is ready before the first welcome can turn portals on. */
export function createRoomLighting(plain: Lighting | null, portals: Portals): RoomLighting {
  const withPortals = plain && bakePortalLighting(plain, portals, FLOOR, CEILING);
  return { lighting: (portalsOn) => (portalsOn ? withPortals : plain) };
}
