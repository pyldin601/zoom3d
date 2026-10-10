import { expect, test } from 'vitest';
import { CHEERS_HOLD_MS, createDrinkPress } from './drink-press';

test('a cheers needs the key held for half a second', () => {
  expect(CHEERS_HOLD_MS).toBe(500);
});

test('a release before 500 ms is a sip', () => {
  const press = createDrinkPress();
  press.down(0);
  expect(press.up(499)).toBe('sip');
});

test('reaching 500 ms is one cheers, and the release after it does nothing', () => {
  const press = createDrinkPress();
  press.down(0);
  expect(press.due(500)).toBe('cheers');
  expect(press.due(500)).toBeNull();
  expect(press.up(900)).toBeNull();
});

test('not yet due before 500 ms', () => {
  const press = createDrinkPress();
  press.down(0);
  expect(press.due(499)).toBeNull();
});

test('a cancelled press fires nothing', () => {
  const press = createDrinkPress();
  press.down(0);
  press.cancel();
  expect(press.up(100)).toBeNull();
  expect(press.due(600)).toBeNull();
});

test('a release or a timer with no press does nothing', () => {
  const press = createDrinkPress();
  expect(press.up(10)).toBeNull();
  expect(press.due(600)).toBeNull();
});

test('a sip ends the press: its timer firing later is no cheers', () => {
  const press = createDrinkPress();
  press.down(0);
  expect(press.up(100)).toBe('sip');
  expect(press.due(500)).toBeNull();
});
