// Slow light's room light timeline (D41): each change of what the instant frame shows of the room's light (its lamp
// table and the portals it sees through), stamped, so every place can be shown what its light left with.
import { openOnly, type Point, type Portals } from '@zoom3d/shared';
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
  /** The sight set shown at `t`, likewise. */
  sightSeenAt(t: number): Portals | null;
  /** The newest sight set held that isn't null: the doorways a wave may show open. */
  lastSight(): Portals | null;
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
  /** The slot shown at `t`: the newest change at or before it, else the oldest. */
  const seenSlot = (t: number) => {
    for (let back = 0; back < count; back++) {
      if ((times[slot(back)] as number) <= t) {
        return slot(back);
      }
    }
    return slot(Math.max(0, count - 1));
  };
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
      return lightings[seenSlot(t)] ?? null;
    },
    sightSeenAt(t) {
      return sights[seenSlot(t)] ?? null;
    },
    lastSight() {
      for (let back = 0; back < count; back++) {
        const sight = sights[slot(back)];
        if (sight) {
          return sight;
        }
      }
      return null;
    },
    changedSince: (t) => count > 1 && (times[slot(0)] as number) > t,
  };
}

/** The sight portals as the eye sees them while a change spreads: each doorway as its own light shows it (D41). */
export interface SeenPortals {
  update(timeline: LightTimeline, eye: Point, now: number, lightSpeed: number): Portals | null;
}

export function createSeenPortals(): SeenPortals {
  let open = new Uint8Array(0);
  let shown: Portals | null = null;
  return {
    update(timeline, eye, now, lightSpeed) {
      const sight = timeline.lastSight();
      if (sight === null) {
        return null;
      }
      if (open.length !== sight.list.length) {
        open = new Uint8Array(sight.list.length);
        shown = null;
      }
      let opened = 0;
      let changed = shown === null || shown.list !== sight.list;
      for (let index = 0; index < sight.list.length; index++) {
        const portal = sight.list[index];
        const tiles = portal ? Math.hypot(portal.cx - eye.x, portal.cy - eye.y) : 0;
        const isOpen = timeline.sightSeenAt(now - (tiles / lightSpeed) * 1000) !== null ? 1 : 0;
        changed ||= open[index] !== isOpen;
        open[index] = isOpen;
        opened += isOpen;
      }
      if (opened === 0) {
        return null;
      }
      if (opened === sight.list.length) {
        return sight;
      }
      if (changed) {
        shown = openOnly(sight, open, shown ?? undefined);
      }
      return shown;
    },
  };
}
