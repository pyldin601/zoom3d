// Fixed 16:9 viewport: the largest centred 16:9 box inside the window (letterboxed).

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
