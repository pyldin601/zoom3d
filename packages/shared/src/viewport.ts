// The stage viewport: a fixed 16:9 letterboxed box on desktop, the whole window on touch devices.

export const INTERNAL_W = 640;
export const INTERNAL_H = 360;

export interface ViewportBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const finite = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

export function fitViewport(windowW: number, windowH: number, pixelPerfect = false): ViewportBox {
  const w = finite(windowW);
  const h = finite(windowH);
  let width: number;
  const k = Math.min(Math.floor(w / INTERNAL_W), Math.floor(h / INTERNAL_H));
  if (pixelPerfect && k >= 1) {
    width = INTERNAL_W * k;
  } else {
    // Multiples of 16 keep height = width * 9 / 16 an exact integer.
    width = Math.floor(Math.min(w, (h * 16) / 9) / 16) * 16;
  }
  const height = (width * 9) / 16;
  return { x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), width, height };
}

// Touch devices (mobile spec §2): the frame fills the window, shaped to it, with an aspect-dependent FOV.

/** Horizontal FOV at 16:9 and wider (today's desktop view). */
export const FOV_WIDE = (66 * Math.PI) / 180;
/** Horizontal FOV on a tall phone (9:19.5 and narrower): fewer people side by side, larger faces. */
export const FOV_TALL = (50 * Math.PI) / 180;
/** The internal buffer's long side on touch devices. */
export const TOUCH_LONG_SIDE = 640;

const ASPECT_WIDE = 16 / 9;
const ASPECT_TALL = 9 / 19.5;

/** Horizontal FOV in radians for a frame of aspect `w / h`: linear in aspect between the tall and wide anchors. */
export function fovForAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect >= ASPECT_WIDE) {
    return FOV_WIDE;
  }
  if (aspect <= ASPECT_TALL) {
    return FOV_TALL;
  }
  return FOV_TALL + ((FOV_WIDE - FOV_TALL) * (aspect - ASPECT_TALL)) / (ASPECT_WIDE - ASPECT_TALL);
}

export interface TouchFrame {
  /** The stage box: the whole window. */
  box: ViewportBox;
  /** Internal framebuffer size. */
  width: number;
  height: number;
  fov: number;
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export function fitTouchViewport(windowW: number, windowH: number): TouchFrame {
  const w = Math.floor(finite(windowW));
  const h = Math.floor(finite(windowH));
  const box = { x: 0, y: 0, width: w, height: h };
  if (w === 0 || h === 0) {
    return { box, width: TOUCH_LONG_SIDE, height: even((TOUCH_LONG_SIDE * 9) / 16), fov: FOV_WIDE };
  }
  const width = w >= h ? TOUCH_LONG_SIDE : even((TOUCH_LONG_SIDE * w) / h);
  const height = w >= h ? even((TOUCH_LONG_SIDE * h) / w) : TOUCH_LONG_SIDE;
  return { box, width, height, fov: fovForAspect(width / height) };
}
