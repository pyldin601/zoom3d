// Positions the stage (game + HUD canvases) inside the window: the fixed 16:9 box on desktop, the whole window on
// touch devices (mobile spec §2). Returns the frame the renderer should draw.
import { fitTouchViewport, fitViewport, INTERNAL_H, INTERNAL_W, type ViewportBox } from '@zoom3d/shared';
import { isTextEntry } from '../input/keyboard';
import { DEFAULT_FOV } from '../renderer/framebuffer';

/** What the renderer draws: internal buffer size and horizontal FOV. */
export interface Frame {
  width: number;
  height: number;
  fov: number;
}

export interface LayoutOptions {
  /** Touch mode (fixed at page load): full-window frame, UI sized from the shorter side. */
  touch: boolean;
  pixelPerfect: boolean;
}

/** UI text size on touch devices, as a fraction of the window's shorter side, but never under TOUCH_MIN_FONT_PX. */
const TOUCH_FONT = 0.045;
const TOUCH_MIN_FONT_PX = 12;
/** UI text size on desktop, as a fraction of the 16:9 box's height (UI is sized in em, so it scales with the box). */
const DESKTOP_FONT = 0.032;
const DESKTOP_MIN_FONT_PX = 8;
/** The HUD's backing ratio on touch devices: phones report 3, which costs a lot to clear every frame. */
const TOUCH_MAX_DPR = 2;

/** The visible area: `visualViewport` follows the iOS toolbar, `innerWidth`/`innerHeight` may not. */
export function viewportSize(): { width: number; height: number } {
  const vv = window.visualViewport;
  return vv ? { width: vv.width, height: vv.height } : { width: window.innerWidth, height: window.innerHeight };
}

export function layoutStage(stage: HTMLElement, hud: HTMLCanvasElement, opts: LayoutOptions): Frame {
  let box: ViewportBox;
  let frame: Frame;
  let fontSize: number;
  let dpr = window.devicePixelRatio || 1;
  if (opts.touch) {
    const size = viewportSize();
    const touch = fitTouchViewport(size.width, size.height);
    box = touch.box;
    frame = { width: touch.width, height: touch.height, fov: touch.fov };
    fontSize = Math.max(TOUCH_MIN_FONT_PX, Math.min(box.width, box.height) * TOUCH_FONT);
    dpr = Math.min(dpr, TOUCH_MAX_DPR);
  } else {
    box = fitViewport(window.innerWidth, window.innerHeight, opts.pixelPerfect);
    frame = { width: INTERNAL_W, height: INTERNAL_H, fov: DEFAULT_FOV };
    fontSize = Math.max(DESKTOP_MIN_FONT_PX, box.height * DESKTOP_FONT);
  }
  Object.assign(stage.style, {
    left: `${box.x}px`,
    top: `${box.y}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    fontSize: `${fontSize}px`,
  });
  hud.width = Math.round(box.width * dpr);
  hud.height = Math.round(box.height * dpr);
  return frame;
}

/**
 * Calls `onChange` whenever the window size or devicePixelRatio changes. With `skipWhileTyping` (touch mode), resizes
 * while a text field has focus are the on-screen keyboard: they are held back and replayed once on focusout.
 */
export function watchLayout(onChange: () => void, { skipWhileTyping = false } = {}): void {
  let pending = false;
  const changed = () => {
    if (skipWhileTyping && isTextEntry(document.activeElement)) {
      pending = true;
      return;
    }
    onChange();
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(changed).observe(document.documentElement);
  }
  window.visualViewport?.addEventListener('resize', changed);
  document.addEventListener('focusout', () => {
    if (pending) {
      pending = false;
      onChange();
    }
  });
  const watchDpr = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        changed();
        watchDpr();
      },
      { once: true }
    );
  };
  watchDpr();
}
