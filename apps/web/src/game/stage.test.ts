// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_FOV } from '../renderer/framebuffer';
import { layoutStage, watchLayout } from './stage';

let stage: HTMLElement;
let hud: HTMLCanvasElement;
const viewport = Object.assign(new EventTarget(), { width: 390, height: 844 });

beforeEach(() => {
  document.body.innerHTML = '<div id="stage"><canvas id="hud"></canvas></div>';
  stage = document.getElementById('stage') as HTMLElement;
  hud = document.getElementById('hud') as HTMLCanvasElement;
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('devicePixelRatio', 3);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('touch layout fills the visual viewport and returns the touch frame', () => {
  const frame = layoutStage(stage, hud, { touch: true, pixelPerfect: false });
  expect([stage.style.width, stage.style.height, stage.style.left, stage.style.top]).toEqual([
    '390px',
    '844px',
    '0px',
    '0px',
  ]);
  expect([frame.width, frame.height]).toEqual([296, 640]);
  expect(frame.fov).toBeLessThan(DEFAULT_FOV);
});

test('touch layout caps the HUD backing ratio at 2 and sizes text from the shorter side', () => {
  layoutStage(stage, hud, { touch: true, pixelPerfect: false });
  expect([hud.width, hud.height]).toEqual([780, 1688]);
  expect(Number.parseFloat(stage.style.fontSize)).toBeCloseTo(390 * 0.045, 6);
});

test('desktop layout keeps the 16:9 box and returns the 640x360 66° frame', () => {
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('innerWidth', 1920);
  vi.stubGlobal('innerHeight', 1200);
  const frame = layoutStage(stage, hud, { touch: false, pixelPerfect: false });
  expect(frame).toEqual({ width: 640, height: 360, fov: DEFAULT_FOV });
  expect([stage.style.width, stage.style.height, stage.style.top]).toEqual(['1920px', '1080px', '60px']);
  expect(hud.width).toBe(1920 * 3);
});

test('relayout is skipped while a text field has focus and runs once on focusout', () => {
  const onChange = vi.fn();
  watchLayout(onChange, { skipWhileTyping: true });
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  viewport.dispatchEvent(new Event('resize'));
  expect(onChange).not.toHaveBeenCalled();
  input.blur();
  document.dispatchEvent(new FocusEvent('focusout'));
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('without a focused field a visual viewport resize relayouts right away', () => {
  const onChange = vi.fn();
  watchLayout(onChange, { skipWhileTyping: true });
  viewport.dispatchEvent(new Event('resize'));
  expect(onChange).toHaveBeenCalledTimes(1);
});
