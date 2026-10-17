// Test helpers for the traced room: a whole bake, and where a point of the room lands in a frame.
import type { GameMap, PlayerState } from '@zoom3d/shared';
import { createView, EYE_HEIGHT, setView } from '../camera';
import type { Framebuffer } from '../framebuffer';
import { bakeLighting } from './bake';
import type { TracedLighting } from './frame';
import { createLightmaps } from './lightmaps';
import { buildTracedWorld } from './world';

export function bakeRoom(
  map: GameMap,
  textures: readonly Uint32Array[],
  lamps: readonly { x: number; y: number }[]
): TracedLighting {
  const world = buildTracedWorld(map, textures, lamps);
  const maps = createLightmaps(world);
  for (const _ of bakeLighting(world, maps)) {
    // Run to the end.
  }
  return { world, maps };
}

/** The pixel that shows the point (x, y) at height z (0 floor .. 1 ceiling) from `eye`. */
export function pixelOf(
  fb: Framebuffer,
  eye: PlayerState,
  x: number,
  y: number,
  z: number
): { col: number; row: number } {
  const view = setView(createView(), fb, eye);
  const offsetX = x - eye.x;
  const offsetY = y - eye.y;
  const across = view.invDet * (view.dirY * offsetX - view.dirX * offsetY);
  const depth = view.invDet * (-view.planeY * offsetX + view.planeX * offsetY);
  return {
    col: Math.floor(view.halfWidth * (1 + across / depth)),
    row: Math.floor(view.half - ((z - EYE_HEIGHT) * view.proj) / depth),
  };
}
