// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { showCountdown } from './portal-countdown';

const countdowns = (ui: HTMLElement) => [...ui.querySelectorAll('.portal-countdown')].map((n) => n.textContent);

test('counts down 3, 2, 1 in one element, and is gone on null', () => {
  const ui = document.createElement('div');
  showCountdown(ui, 3);
  expect(countdowns(ui)).toEqual(['Portals will enable in 3…']);
  const element = ui.querySelector('.portal-countdown');
  showCountdown(ui, 3);
  showCountdown(ui, 2);
  expect(countdowns(ui)).toEqual(['Portals will enable in 2…']);
  showCountdown(ui, 1);
  expect(countdowns(ui)).toEqual(['Portals will enable in 1…']);
  expect(ui.querySelector('.portal-countdown')).toBe(element);
  showCountdown(ui, null);
  expect(countdowns(ui)).toEqual([]);
  showCountdown(ui, null);
  expect(countdowns(ui)).toEqual([]);
});

test('shows again after it was removed, and in whichever ui it is given', () => {
  const first = document.createElement('div');
  const second = document.createElement('div');
  showCountdown(first, 3);
  showCountdown(first, null);
  showCountdown(first, 2);
  expect(countdowns(first)).toEqual(['Portals will enable in 2…']);
  showCountdown(second, 2);
  expect(countdowns(first)).toEqual([]);
  expect(countdowns(second)).toEqual(['Portals will enable in 2…']);
  showCountdown(second, null);
});
