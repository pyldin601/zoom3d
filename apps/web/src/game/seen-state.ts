// Slow light's seen state (D41): what a thing holds and does, kept as a few stamped changes so the eye can be shown
// the state its light left with. Preallocated: pushing and reading allocate nothing.
import type { HeldItem } from '@zoom3d/shared';
import type { RemotePeer } from '../net/session';

/** Stamped values, newest last; a push equal to the newest is dropped. */
export interface StateRing<T> {
  push(t: number, value: T): void;
  /** The newest value stamped at or before `t`, or the oldest; read it before the next push. */
  at(t: number): T;
  readonly empty: boolean;
  /** When the oldest value held was stamped; +Infinity when empty. */
  readonly oldestAt: number;
  clear(): void;
}

export function createStateRing<T>(
  capacity: number,
  blank: () => T,
  copy: (from: T, to: T) => void,
  same: (a: T, b: T) => boolean
): StateRing<T> {
  const values = Array.from({ length: capacity }, blank);
  const times = new Float64Array(capacity);
  /** Where the next push goes, and how many are held. */
  let next = 0;
  let count = 0;
  const slot = (back: number) => (next - 1 - back + capacity) % capacity;
  const valueAt = (back: number) => values.at(slot(back)) as T;
  return {
    push(t, value) {
      if (count > 0 && same(valueAt(0), value)) {
        return;
      }
      copy(value, values.at(next) as T);
      times[next] = t;
      next = (next + 1) % capacity;
      count = Math.min(capacity, count + 1);
    },
    at(t) {
      for (let back = 0; back < count; back++) {
        if ((times[slot(back)] as number) <= t) {
          return valueAt(back);
        }
      }
      return valueAt(Math.max(0, count - 1));
    },
    get empty() {
      return count === 0;
    },
    get oldestAt() {
      return count === 0 ? Number.POSITIVE_INFINITY : (times[slot(count - 1)] as number);
    },
    clear() {
      count = 0;
    },
  };
}

/** What a peer shows besides where they are. */
export interface PeerLook {
  held: HeldItem | null;
  boombox: boolean;
  riding: string | null;
  mic: boolean;
  /** The session's own gesture record, compared by identity: each sip or cheers is a new one. */
  gesture: RemotePeer['gesture'];
}

export const blankLook = (): PeerLook => ({ held: null, boombox: false, riding: null, mic: false, gesture: null });

export function copyLook(from: PeerLook, to: PeerLook): void {
  to.held = from.held;
  to.boombox = from.boombox;
  to.riding = from.riding;
  to.mic = from.mic;
  to.gesture = from.gesture;
}

export const sameLook = (a: PeerLook, b: PeerLook): boolean =>
  a.held === b.held && a.boombox === b.boombox && a.riding === b.riding && a.mic === b.mic && a.gesture === b.gesture;

/** A peer's live look into `out`. */
export function liveLook(peer: RemotePeer, out: PeerLook): PeerLook {
  out.held = peer.info.held;
  out.boombox = peer.info.boombox;
  out.riding = peer.info.riding;
  out.mic = peer.info.mic;
  out.gesture = peer.gesture;
  return out;
}

/** Changes a look can go through within the longest light time: items are switched by hand, a few a second at most. */
export const LOOK_CAPACITY = 32;

export const createLookRing = (): StateRing<PeerLook> => createStateRing(LOOK_CAPACITY, blankLook, copyLook, sameLook);
