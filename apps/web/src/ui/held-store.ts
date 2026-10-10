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

const KEY_ITEMS: Record<string, HeldItem | null> = {
  Digit0: null,
  Digit1: 'beer',
  Digit2: 'coffee',
  Digit3: 'wine',
  Numpad0: null,
  Numpad1: 'beer',
  Numpad2: 'coffee',
  Numpad3: 'wine',
};

/** The drink a number key picks (by key position, so any layout): 1–3 a drink, 0 nothing; undefined otherwise. */
export function heldForKey(code: string): HeldItem | null | undefined {
  return Object.hasOwn(KEY_ITEMS, code) ? KEY_ITEMS[code] : undefined;
}

/**
 * A drink key sips or cheers the drink already in hand (by press length, held items spec §2.4); otherwise it picks
 * that drink (or nothing).
 */
export function heldKeyAction(keyItem: HeldItem | null, holding: HeldItem | null): 'sip' | 'pick' {
  return keyItem !== null && keyItem === holding ? 'sip' : 'pick';
}
