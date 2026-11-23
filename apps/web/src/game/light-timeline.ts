// Slow light's room light timeline (D41): each change of what the instant frame shows of the room's light (its lamp
// table and the portals it sees through), stamped, so every place can be shown what its light left with.
import type { Portals } from '@zoom3d/shared';
import type { LightChanges } from '../renderer/light-wave';
import type { Lighting } from '../renderer/lighting';

export interface LightTimeline extends LightChanges {
  /** Notes what the instant frame shows at `t`; kept only when it changed. */
  record(t: number, lighting: Lighting | null, sight: Portals | null): void;
  /** Starts again from what is shown at `t`: a change of this person's settings, not of the room's light. */
  reset(t: number, lighting: Lighting | null, sight: Portals | null): void;
  sightAt(back: number): Portals | null;
  /** The lighting shown at `t`: the newest change at or before it, else the oldest. */
  lightingSeenAt(t: number): Lighting | null;
  /** Whether a change newer than `t` is held: some place may still show what came before it. */
  changedSince(t: number): boolean;
}

/** Changes within the longest light time: a portal sequence makes three, Y pressed again three more. */
const CAPACITY = 16;

export function createLightTimeline(capacity = CAPACITY): LightTimeline {
  const times = new Float64Array(capacity);
  const lightings: (Lighting | null)[] = new Array(capacity).fill(null);
  const sights: (Portals | null)[] = new Array(capacity).fill(null);
  let next = 0;
  let count = 0;
  const slot = (back: number) => (next - 1 - back + capacity) % capacity;
  const push = (t: number, lighting: Lighting | null, sight: Portals | null) => {
    times[next] = t;
    lightings[next] = lighting;
    sights[next] = sight;
    next = (next + 1) % capacity;
    count = Math.min(capacity, count + 1);
  };
  return {
    get count() {
      return count;
    },
    timeAt: (back) => times[slot(back)] as number,
    lightingAt: (back) => lightings[slot(back)] ?? null,
    sightAt: (back) => sights[slot(back)] ?? null,
    record(t, lighting, sight) {
      if (count > 0 && lightings[slot(0)] === lighting && sights[slot(0)] === sight) {
        return;
      }
      push(t, lighting, sight);
    },
    reset(t, lighting, sight) {
      count = 0;
      push(t, lighting, sight);
    },
    lightingSeenAt(t) {
      for (let back = 0; back < count; back++) {
        if ((times[slot(back)] as number) <= t) {
          return lightings[slot(back)] ?? null;
        }
      }
      return count === 0 ? null : (lightings[slot(count - 1)] ?? null);
    },
    changedSince: (t) => count > 1 && (times[slot(0)] as number) > t,
  };
}
