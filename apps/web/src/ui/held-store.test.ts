import { expect, test } from 'vitest';
import { HELD_KEY, heldForKey, heldKeyAction, loadHeld, saveHeld } from './held-store';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test('round-trips an item and null', () => {
  const s = memoryStorage();
  saveHeld(s, 'wine');
  expect(s.map.get(HELD_KEY)).toBe('wine');
  expect(loadHeld(s)).toBe('wine');
  saveHeld(s, null);
  expect(s.map.has(HELD_KEY)).toBe(false);
  expect(loadHeld(s)).toBeNull();
});

test('junk loads as null', () => {
  expect(HELD_KEY).toBe('zoom3d.held');
  expect(loadHeld({ getItem: () => 'pizza' })).toBeNull();
});

test('throwing or missing storage is tolerated', () => {
  const boom = () => {
    throw new Error('blocked');
  };
  expect(loadHeld({ getItem: boom })).toBeNull();
  expect(() => saveHeld({ setItem: boom, removeItem: boom }, 'beer')).not.toThrow();
  expect(() => saveHeld({ setItem: boom, removeItem: boom }, null)).not.toThrow();
  expect(loadHeld(null)).toBeNull();
  expect(() => saveHeld(null, 'beer')).not.toThrow();
});

test('number keys pick a drink: 1 beer, 2 coffee, 3 wine, 0 nothing', () => {
  expect(heldForKey('Digit1')).toBe('beer');
  expect(heldForKey('Digit2')).toBe('coffee');
  expect(heldForKey('Digit3')).toBe('wine');
  expect(heldForKey('Digit0')).toBeNull();
  expect(heldForKey('Numpad1')).toBe('beer');
  expect(heldForKey('Numpad3')).toBe('wine');
  expect(heldForKey('Numpad0')).toBeNull();
});

test('other keys are not drink keys', () => {
  for (const code of ['Digit4', 'Digit9', 'Numpad5', 'KeyW', 'KeyB', 'Space', '']) {
    expect(heldForKey(code)).toBeUndefined();
  }
});

test('the key of the drink already in hand sips; any other drink key picks', () => {
  expect(heldKeyAction('beer', 'beer')).toBe('sip');
  expect(heldKeyAction('coffee', 'beer')).toBe('pick');
  expect(heldKeyAction('beer', null)).toBe('pick');
  expect(heldKeyAction(null, 'beer')).toBe('pick');
  expect(heldKeyAction(null, null)).toBe('pick');
});
