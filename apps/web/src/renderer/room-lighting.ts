// The room's lamp light, baked on first use (about 100 ms) rather than at page load, so the landing page never waits
// for it; by then the join is already connecting.
import type { GameMap } from '@zoom3d/shared';
import { bakeLighting, corridorLights, type Lighting } from './lighting';
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
