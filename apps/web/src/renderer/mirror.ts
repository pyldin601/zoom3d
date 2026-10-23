// The floor's mirror of the voxel objects (voxel shadows spec §3.3): each object is drawn upside down into a scratch
// buffer with coverage, box-blurred as softly as the floor's lamp reflections, then mixed faintly over the floor.
// Every pass works on the object's screen box only. Allocation-free once the buffer fits the frame.
import type { Framebuffer } from './framebuffer';

/** Pixels, [left, right) × [top, bottom). */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MirrorBuffer {
  /** Fits the buffer to a frame of this size, growing only when it must. */
  fit(width: number, height: number): void;
  clear(box: ScreenBox): void;
  /** Covers pixel (x, y) with `colour`, a packed rgb(). */
  plot(x: number, y: number, colour: number): void;
  /** Box-blurs colour and coverage over `box` by `radiusPx` each way, across then down. */
  blur(box: ScreenBox, radiusPx: number): void;
  /**
   * Mixes the buffer over `fb` in `box` at `strength`, on rows from `floorFrom[col]` down only: each pixel goes
   * `strength · coverage` of the way to the mirror's colour.
   */
  blendInto(fb: Framebuffer, box: ScreenBox, strength: number, floorFrom: Int32Array): void;
  coverageAt(x: number, y: number): number;
}

export function createMirrorBuffer(): MirrorBuffer {
  let width = 0;
  /** Per pixel, r, g, b times coverage, then coverage. */
  let data = new Float32Array(0);
  /** One row or column of the box being blurred, 4 channels a pixel. */
  let line = new Float32Array(0);

  /** Box-blurs `count` pixels from `first`, `step` floats apart, by `radius` each way, in place. */
  const blurLine = (first: number, step: number, count: number, radius: number) => {
    // Copied by hand: subarray() would make a view object per pixel.
    for (let i = 0; i < count; i++) {
      for (let ch = 0; ch < 4; ch++) {
        line[i * 4 + ch] = data[first + i * step + ch] as number;
      }
    }
    const span = 2 * radius + 1;
    for (let ch = 0; ch < 4; ch++) {
      // A running sum over the window; past the line's ends counts as empty.
      let sum = 0;
      for (let i = 0; i < Math.min(radius, count); i++) {
        sum += line[i * 4 + ch] as number;
      }
      for (let i = 0; i < count; i++) {
        const entering = i + radius;
        const leaving = i - radius - 1;
        if (entering < count) {
          sum += line[entering * 4 + ch] as number;
        }
        if (leaving >= 0) {
          sum -= line[leaving * 4 + ch] as number;
        }
        data[first + i * step + ch] = sum / span;
      }
    }
  };

  return {
    fit(w, h) {
      width = w;
      if (data.length < w * h * 4) {
        data = new Float32Array(w * h * 4);
        line = new Float32Array(Math.max(w, h) * 4);
      }
    },
    clear({ left, top, right, bottom }) {
      for (let y = top; y < bottom; y++) {
        data.fill(0, (y * width + left) * 4, (y * width + right) * 4);
      }
    },
    plot(x, y, colour) {
      const at = (y * width + x) * 4;
      data[at] = colour & 0xff;
      data[at + 1] = (colour >>> 8) & 0xff;
      data[at + 2] = (colour >>> 16) & 0xff;
      data[at + 3] = 1;
    },
    blur({ left, top, right, bottom }, radiusPx) {
      for (let y = top; y < bottom; y++) {
        blurLine((y * width + left) * 4, 4, right - left, radiusPx);
      }
      for (let x = left; x < right; x++) {
        blurLine((top * width + x) * 4, width * 4, bottom - top, radiusPx);
      }
    },
    blendInto(fb, { left, top, right, bottom }, strength, floorFrom) {
      const { pixels } = fb;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const at = (y * width + x) * 4;
          const share = strength * (data[at + 3] as number);
          if (share <= 0 || y < (floorFrom[x] as number)) {
            continue;
          }
          const p = y * fb.width + x;
          const c = pixels[p] as number;
          const r = (c & 0xff) * (1 - share) + strength * (data[at] as number);
          const g = ((c >>> 8) & 0xff) * (1 - share) + strength * (data[at + 1] as number);
          const b = ((c >>> 16) & 0xff) * (1 - share) + strength * (data[at + 2] as number);
          pixels[p] =
            ((c & 0xff000000) | (Math.min(255, b | 0) << 16) | (Math.min(255, g | 0) << 8) | Math.min(255, r | 0)) >>>
            0;
        }
      }
    },
    coverageAt(x, y) {
      return data[(y * width + x) * 4 + 3] as number;
    },
  };
}
