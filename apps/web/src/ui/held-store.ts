// The drink in hand, remembered per browser; storage may be missing or throw (private mode, blocked).
import { type HeldItem, isHeldItem } from '@zoom3d/shared';

export const HELD_KEY = 'zoom3d.held';

export function loadHeld(storage: Pick<Storage, 'getItem'> | null): HeldItem | null {
  try {
    const v = storage?.getItem(HELD_KEY);
    return isHeldItem(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveHeld(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, item: HeldItem | null): void {
  try {
    if (item === null) {
      storage?.removeItem(HELD_KEY);
    } else {
      storage?.setItem(HELD_KEY, item);
    }
  } catch {
    // Not remembered; it is still shown for this session.
  }
}
