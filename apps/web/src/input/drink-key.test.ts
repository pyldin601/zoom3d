import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createGestureClock, type Gesture } from '../renderer/sip';
import { CHEERS_HOLD_MS } from '../ui/drink-press';
import { createDrinkKey } from './drink-key';

let gestures: Gesture[];
let inRoom: boolean;
let clock: number;

beforeEach(() => {
  vi.useFakeTimers();
  gestures = [];
  inRoom = true;
  clock = 1000;
});
afterEach(() => vi.useRealTimers());

function drinkKey() {
  return createDrinkKey({
    gesture: createGestureClock(),
    canGesture: () => inRoom,
    onGesture: (kind) => gestures.push(kind),
    now: () => clock,
  });
}

/** Moves the clock and the timers on together. */
function wait(ms: number) {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

test('a tap sips on release', () => {
  const key = drinkKey();
  key.down(clock, 'Digit1');
  wait(100);
  key.up(clock, 'Digit1');
  expect(gestures).toEqual(['sip']);
});

test('a press held CHEERS_HOLD_MS cheers right then, and its release adds nothing', () => {
  const key = drinkKey();
  key.down(clock, 'Digit1');
  wait(CHEERS_HOLD_MS);
  expect(gestures).toEqual(['cheers']);
  wait(100);
  key.up(clock, 'Digit1');
  expect(gestures).toEqual(['cheers']);
});

test('a release that comes before a late hold timer settles the press as a cheers', () => {
  const key = drinkKey();
  key.down(clock, 'Digit1');
  // The release event says the key was down for longer than the hold, though the timer hasn't run yet.
  key.up(clock + CHEERS_HOLD_MS + 50, 'Digit1');
  wait(CHEERS_HOLD_MS);
  expect(gestures).toEqual(['cheers']);
});

test('no press starts while a gesture plays, nor a second one while one is down', () => {
  const key = drinkKey();
  key.down(clock, 'Digit1');
  key.down(clock, 'touch');
  key.up(clock + 100, 'touch');
  expect(gestures).toEqual([]);
  key.up(clock + 100, 'Digit1');
  expect(gestures).toEqual(['sip']);
  key.down(clock + 200, 'Digit1');
  key.up(clock + 300, 'Digit1');
  expect(gestures).toEqual(['sip']);
});

test('a cancelled press does nothing; a cancel for another source leaves it alone', () => {
  const key = drinkKey();
  key.down(clock, 'Digit1');
  key.cancel('touch');
  key.up(clock + 100, 'Digit1');
  expect(gestures).toEqual(['sip']);
  wait(5000);
  key.down(clock, 'Digit1');
  key.cancel();
  wait(CHEERS_HOLD_MS);
  key.up(clock, 'Digit1');
  expect(gestures).toEqual(['sip']);
});

test('nothing plays while the room is reconnecting', () => {
  inRoom = false;
  const key = drinkKey();
  key.down(clock, 'Digit1');
  key.up(clock + 100, 'Digit1');
  key.down(clock + 200, 'Digit1');
  wait(CHEERS_HOLD_MS);
  expect(gestures).toEqual([]);
});
