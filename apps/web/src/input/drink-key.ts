// The held drink's key, a number key or the touch drink button (held items spec §2.4): a tap sips on release, a press
// held CHEERS_HOLD_MS raises a cheers right then. One press at a time, timed by the input events' own timeStamps (the
// performance.now() clock), so a busy main thread can't stretch a tap into a cheers.
import type { Gesture, GestureClock } from '../renderer/sip';
import { CHEERS_HOLD_MS, createDrinkPress } from '../ui/drink-press';

export interface DrinkKeyOptions {
  /** The local player's gesture clock: no press starts while it plays a gesture. */
  gesture: GestureClock;
  /** Whether a gesture may start now; not while reconnecting, as the others would never see it. */
  canGesture(): boolean;
  /** A sip or cheers started: tell the others. */
  onGesture(kind: Gesture): void;
  /** The performance.now() clock. */
  now?: () => number;
}

export interface DrinkKey {
  /** A press began at `at`: `source` is the key's code, or 'touch'. Ignored while a gesture plays or a press is down. */
  down(at: number, source: string): void;
  /** `source` was released at `at`: a sip, a cheers if the hold timer is running late, or nothing. */
  up(at: number, source: string): void;
  /** Forgets the press: any press, or only one from `source` (the touch button's own cancel). */
  cancel(source?: string): void;
}

export function createDrinkKey(opts: DrinkKeyOptions): DrinkKey {
  const now = opts.now ?? (() => performance.now());
  const press = createDrinkPress();
  /** What is pressing, and the timer that turns a long press into a cheers; null between presses. */
  let down: { source: string; timer: ReturnType<typeof setTimeout> } | null = null;

  const cancel = () => {
    press.cancel();
    if (down) {
      clearTimeout(down.timer);
      down = null;
    }
  };

  const play = (kind: Gesture, at: number) => {
    if (opts.canGesture() && opts.gesture.start(kind, at)) {
      opts.onGesture(kind);
    }
  };

  /** The hold timer: a cheers once the key has been down CHEERS_HOLD_MS. */
  const holdReached = (downAt: number) => {
    // A timer can fire a hair before the clock reads CHEERS_HOLD_MS; it is due either way.
    const at = Math.max(now(), downAt + CHEERS_HOLD_MS);
    if (press.due(at) === 'cheers') {
      down = null;
      play('cheers', at);
    }
  };

  return {
    down(at, source) {
      if (opts.gesture.kind(now()) !== null || down !== null) {
        return;
      }
      press.down(at);
      down = { source, timer: setTimeout(() => holdReached(at), CHEERS_HOLD_MS) };
    },
    up(at, source) {
      if (down?.source !== source) {
        return;
      }
      // A cheers here means the hold timer is running late; the release settles it instead.
      const kind = press.up(at);
      cancel();
      if (kind) {
        play(kind, now());
      }
    },
    cancel(source) {
      if (source === undefined || down?.source === source) {
        cancel();
      }
    },
  };
}
