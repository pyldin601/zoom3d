// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import { showTouchControls, type TouchControlsOptions } from './touch-controls';

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="ui"></div>';
  root = document.getElementById('ui') as HTMLElement;
});

function options(overrides: Partial<TouchControlsOptions> = {}): TouchControlsOptions {
  return {
    held: null,
    boombox: false,
    map: false,
    onPick: vi.fn(),
    onDrinkDown: vi.fn(),
    onDrinkUp: vi.fn(),
    onDrinkCancel: vi.fn(),
    onBoombox: vi.fn(),
    onMap: vi.fn(),
    ...overrides,
  };
}

const $ = <T extends HTMLElement = HTMLButtonElement>(sel: string) => root.querySelector(sel) as T;
const tray = () => $<HTMLElement>('.tray');
const pointer = (target: Element, type: string, pointerType = 'touch') => {
  const e = new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType });
  target.dispatchEvent(e);
  return e;
};

test('the pad, the more button and a hidden tray are shown', () => {
  showTouchControls(root, options());
  expect($('.touch-pad').getAttribute('aria-label')).toBe('Move');
  expect($('.more').getAttribute('aria-label')).toBe('More');
  expect(tray().hidden).toBe(true);
});

test('⋯ opens the tray; picking a drink calls onPick and closes it', () => {
  const opts = options();
  showTouchControls(root, opts);
  $('.more').click();
  expect(tray().hidden).toBe(false);
  $('[aria-label="Coffee"]').click();
  expect(opts.onPick).toHaveBeenCalledWith('coffee');
  expect(tray().hidden).toBe(true);
});

test('Nothing puts the drink down', () => {
  const opts = options({ held: 'beer' });
  showTouchControls(root, opts);
  $('.more').click();
  $('[aria-label="Nothing"]').click();
  expect(opts.onPick).toHaveBeenCalledWith(null);
});

test('⋯ again or a tap outside the tray closes it', () => {
  showTouchControls(root, options());
  $('.more').click();
  $('.more').click();
  expect(tray().hidden).toBe(true);
  $('.more').click();
  pointer(document.body, 'pointerdown');
  expect(tray().hidden).toBe(true);
});

test('a tap inside the tray does not close it before the click lands', () => {
  showTouchControls(root, options());
  $('.more').click();
  pointer($('[aria-label="Wine"]'), 'pointerdown');
  expect(tray().hidden).toBe(false);
});

test('the drink button shows only while holding, with the drink in its name', () => {
  const controls = showTouchControls(root, options());
  expect($('.drink').hidden).toBe(true);
  controls.update({ held: 'beer', boombox: false, map: false });
  expect($('.drink').hidden).toBe(false);
  expect($('.drink').getAttribute('aria-label')).toBe('Sip beer (hold to cheers)');
});

test('the drink button reports down and up with the event timeStamp', () => {
  const opts = options({ held: 'wine' });
  showTouchControls(root, opts);
  const down = pointer($('.drink'), 'pointerdown');
  expect(opts.onDrinkDown).toHaveBeenCalledWith(down.timeStamp);
  const up = pointer($('.drink'), 'pointerup');
  expect(opts.onDrinkUp).toHaveBeenCalledWith(up.timeStamp);
  expect(opts.onDrinkCancel).not.toHaveBeenCalled();
});

test('pointercancel or leaving the drink button cancels the press, once', () => {
  const opts = options({ held: 'wine' });
  showTouchControls(root, opts);
  pointer($('.drink'), 'pointerdown');
  pointer($('.drink'), 'pointercancel');
  pointer($('.drink'), 'pointerleave');
  expect(opts.onDrinkCancel).toHaveBeenCalledTimes(1);
  pointer($('.drink'), 'pointerdown');
  pointer($('.drink'), 'pointerleave');
  expect(opts.onDrinkCancel).toHaveBeenCalledTimes(2);
  pointer($('.drink'), 'pointerup');
  expect(opts.onDrinkUp).not.toHaveBeenCalled();
});

test('boombox and map buttons call their handlers, close the tray and reflect state', () => {
  const opts = options();
  const controls = showTouchControls(root, opts);
  $('.more').click();
  $('[data-action="boombox"]').click();
  expect(opts.onBoombox).toHaveBeenCalledTimes(1);
  expect(tray().hidden).toBe(true);
  $('.more').click();
  $('[data-action="map"]').click();
  expect(opts.onMap).toHaveBeenCalledTimes(1);
  controls.update({ held: null, boombox: true, map: true });
  expect($('[data-action="boombox"]').getAttribute('aria-label')).toBe('Stop music');
  expect($('[data-action="map"]').getAttribute('aria-pressed')).toBe('true');
  controls.update({ held: null, boombox: false, map: false });
  expect($('[data-action="boombox"]').getAttribute('aria-label')).toBe('Boombox');
  expect($('[data-action="map"]').getAttribute('aria-pressed')).toBe('false');
});

test('the held drink is marked in the tray', () => {
  showTouchControls(root, options({ held: 'coffee' }));
  expect($('[aria-label="Coffee"]').getAttribute('aria-pressed')).toBe('true');
  expect($('[aria-label="Beer"]').getAttribute('aria-pressed')).toBe('false');
});

test('the pad lights up while touched', () => {
  showTouchControls(root, options());
  const pad = $<HTMLElement>('.touch-pad');
  pointer(pad, 'pointerdown');
  expect(pad.classList.contains('active')).toBe(true);
  pointer(pad, 'pointerup');
  expect(pad.classList.contains('active')).toBe(false);
  pointer(pad, 'pointerdown');
  pointer(pad, 'pointercancel');
  expect(pad.classList.contains('active')).toBe(false);
});

test('remove takes every control away', () => {
  const controls = showTouchControls(root, options());
  controls.remove();
  expect(root.querySelector('.touch-pad, .more, .tray, .drink')).toBeNull();
});
