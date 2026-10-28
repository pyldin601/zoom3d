// Where each remote thing appears to the local player this frame (portal spec 2.6): the audio, the face subscription
// and the name labels all read the same answer. Each id keeps one Apparent, so a steady room allocates nothing.
import { type Apparent, apparentPosition, type GameMap, type Portals } from '@zoom3d/shared';

type Point = { x: number; y: number };

export interface ApparentWorld {
  /** One entry per thing; the same objects from call to call, and ids not in `things` any more are dropped. */
  update(
    map: GameMap,
    portals: Portals | null,
    eye: Point,
    things: Iterable<{ id: string; x: number; y: number }>
  ): ReadonlyMap<string, Apparent>;
}

export function createApparentWorld(): ApparentWorld {
  const apparent = new Map<string, Apparent>();
  const stampOf = new Map<string, number>();
  let stamp = 0;

  return {
    update(map, portals, eye, things) {
      stamp++;
      for (const thing of things) {
        let entry = apparent.get(thing.id);
        if (entry === undefined) {
          entry = { x: 0, y: 0, sees: false, through: 0, cos: 1, sin: 0 };
          apparent.set(thing.id, entry);
        }
        apparentPosition(map, portals, eye, thing, entry);
        stampOf.set(thing.id, stamp);
      }
      for (const [id, last] of stampOf) {
        if (last !== stamp) {
          stampOf.delete(id);
          apparent.delete(id);
        }
      }
      return apparent;
    },
  };
}
