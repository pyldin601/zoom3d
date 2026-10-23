// The floor's mirror of the voxel objects (voxel shadows spec §3.3): each object is drawn upside down into a scratch
// buffer with coverage and box-blurred as softly as the floor's lamp reflections, then merged into the frame's mirror
// layer. Under the layer the floor's lamp reflections are hidden, as the objects' images stand in front of the lamps'
// in the floor; then the images' own colour is added. Allocation-free once the buffers fit the frame.
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
  coverageAt(x: number, y: number): number;
  /** Per pixel, r, g, b times coverage, then coverage, rows of the frame's width. */
  data(): Float32Array;
}

/** The frame's objects' images in the floor, merged far to near. */
export interface MirrorLayer {
  /** Fits the layer to a frame of this size, growing only when it must. */
  fit(width: number, height: number): void;
  /** Empties what was merged since the last clear. */
  clear(): void;
  /** Lays `from`'s image in `box` over the layer at `weight` (0..1) of its coverage and colour. */
  merge(from: MirrorBuffer, box: ScreenBox, weight: number): void;
  /** Rows the layer covers anything on, [top, bottom), and columns, [left, right). Empty when right ≤ left. */
  readonly bounds: ScreenBox;
  coverageAt(x: number, y: number): number;
  /** Adds `strength` of the layer's colour to `fb`, on rows from `floorFrom[col]` down. */
  addInto(fb: Framebuffer, strength: number, floorFrom: Int32Array): void;
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
    data() {
      return data;
    },
    coverageAt(x, y) {
      return data[(y * width + x) * 4 + 3] as number;
    },
  };
}

export function createMirrorLayer(): MirrorLayer {
  let width = 0;
  let data = new Float32Array(0);
  const bounds: ScreenBox = { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    bounds,
    fit(w, h) {
      if (w !== width) {
        bounds.right = 0;
      }
      width = w;
      if (data.length < w * h * 4) {
        data = new Float32Array(w * h * 4);
      }
    },
    clear() {
      for (let y = bounds.top; y < bounds.bottom && bounds.left < bounds.right; y++) {
        data.fill(0, (y * width + bounds.left) * 4, (y * width + bounds.right) * 4);
      }
      bounds.left = 0;
      bounds.top = 0;
      bounds.right = 0;
      bounds.bottom = 0;
    },
    merge(from, { left, top, right, bottom }, weight) {
      const src = from.data();
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const at = (y * width + x) * 4;
          const a = (src[at + 3] as number) * weight;
          if (a <= 0) {
            continue;
          }
          // The nearer image (merged later) over the farther: premultiplied "over".
          const keep = 1 - a;
          data[at] = (data[at] as number) * keep + (src[at] as number) * weight;
          data[at + 1] = (data[at + 1] as number) * keep + (src[at + 1] as number) * weight;
          data[at + 2] = (data[at + 2] as number) * keep + (src[at + 2] as number) * weight;
          data[at + 3] = (data[at + 3] as number) * keep + a;
        }
      }
      const empty = bounds.right <= bounds.left;
      bounds.left = empty ? left : Math.min(bounds.left, left);
      bounds.top = empty ? top : Math.min(bounds.top, top);
      bounds.right = empty ? right : Math.max(bounds.right, right);
      bounds.bottom = empty ? bottom : Math.max(bounds.bottom, bottom);
    },
    coverageAt(x, y) {
      return data[(y * width + x) * 4 + 3] as number;
    },
    addInto(fb, strength, floorFrom) {
      const { pixels } = fb;
      for (let y = bounds.top; y < bounds.bottom; y++) {
        for (let x = bounds.left; x < bounds.right; x++) {
          const at = (y * width + x) * 4;
          if ((data[at + 3] as number) <= 0 || y < (floorFrom[x] as number)) {
            continue;
          }
          const p = y * fb.width + x;
          const c = pixels[p] as number;
          const r = Math.min(255, ((c & 0xff) + strength * (data[at] as number)) | 0);
          const g = Math.min(255, (((c >>> 8) & 0xff) + strength * (data[at + 1] as number)) | 0);
          const b = Math.min(255, (((c >>> 16) & 0xff) + strength * (data[at + 2] as number)) | 0);
          pixels[p] = ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
        }
      }
    },
  };
}
