// The held drink's key (held items spec §2.4): a quick press sips on release, one held for CHEERS_HOLD_MS raises a
// cheers at that moment. Pure timing; main.ts feeds it key events and a timer.

export const CHEERS_HOLD_MS = 500;

export interface DrinkPress {
  down(now: number): void;
  /** The key came up: a sip if it was a quick press, else nothing. */
  up(now: number): 'sip' | null;
  /** The hold timer fired: a cheers once the key has been down CHEERS_HOLD_MS, else nothing. */
  due(now: number): 'cheers' | null;
  /** Forgets the press (focus lost, drink changed). */
  cancel(): void;
}

export function createDrinkPress(): DrinkPress {
  let pressedAt: number | null = null;
  return {
    down(now) {
      pressedAt = now;
    },
    up(now) {
      const quick = pressedAt !== null && now - pressedAt < CHEERS_HOLD_MS;
      pressedAt = null;
      return quick ? 'sip' : null;
    },
    due(now) {
      if (pressedAt === null || now - pressedAt < CHEERS_HOLD_MS) {
        return null;
      }
      pressedAt = null;
      return 'cheers';
    },
    cancel() {
      pressedAt = null;
    },
  };
}
