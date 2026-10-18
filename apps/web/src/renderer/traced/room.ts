// The traced room's lighting, baked a slice per frame (spec
// docs/superpowers/specs/2026-10-17-ray-traced-renderer-design.md §2): the room loop spends a few milliseconds on it
// each frame while the mode is traced, and the lit renderer keeps drawing until it is done. Switching modes only
// pauses it.
import type { GameMap } from '@zoom3d/shared';
import { corridorLights } from '../lighting';
import { bakeLighting } from './bake';
import type { TracedLighting } from './frame';
import { createLightmaps } from './lightmaps';
import { buildTracedWorld } from './world';

/** What one frame spends on the bake. A frame goes over by at most one slice (0.1 ms, a few ms in the last passes). */
export const BAKE_SLICE_MS = 6;

export interface TracedRoom {
  /** Bakes for `budgetMs` (at least one slice, so even 0 moves on); does nothing once done, or for an unlit room. */
  bake(budgetMs: number): void;
  /** The lighting once the bake has finished; null before, and always for an unlit room. */
  lighting(): TracedLighting | null;
}

interface BakeUnderWay {
  kind: 'under way';
  /** Its maps fill as the slices run. */
  lighting: TracedLighting;
  slices: Generator<number, void, void>;
}

type Progress = { kind: 'not started' } | BakeUnderWay | { kind: 'done'; lighting: TracedLighting };

/** `lit` false is `?lights=off`: the room is flat in every mode, so there is nothing to bake. */
export function createTracedRoom(map: GameMap, textures: readonly Uint32Array[], lit: boolean): TracedRoom {
  let progress: Progress = { kind: 'not started' };
  return {
    bake(budgetMs) {
      if (!lit) {
        return;
      }
      if (progress.kind === 'not started') {
        progress = startBake(map, textures);
      }
      if (progress.kind === 'under way') {
        progress = bakeFor(progress, budgetMs);
      }
    },
    lighting: () => (progress.kind === 'done' ? progress.lighting : null),
  };
}

function startBake(map: GameMap, textures: readonly Uint32Array[]): BakeUnderWay {
  const world = buildTracedWorld(map, textures, corridorLights(map));
  const lighting = { world, maps: createLightmaps(world) };
  return { kind: 'under way', lighting, slices: bakeLighting(world, lighting.maps) };
}

function bakeFor(bake: BakeUnderWay, budgetMs: number): Progress {
  const deadline = performance.now() + budgetMs;
  do {
    if (bake.slices.next().done) {
      return { kind: 'done', lighting: bake.lighting };
    }
  } while (performance.now() < deadline);
  return bake;
}
