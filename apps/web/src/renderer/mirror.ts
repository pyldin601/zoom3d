// The floor's mirror (floor mirror spec §3): the walls' images, then the people's and objects', far to near, plotted
// at full resolution into one layer and blurred once at half resolution, with a radius that grows towards the eye.
// Under the people's and objects' images the floor's lamp reflections are hidden, as they stand in front of the
// lamps' in the floor; then the layer's colour is added. Allocation-free once the buffers fit the frame.
import type { Framebuffer } from './framebuffer';

/** What a plotted pixel of the floor mirror is: an image that shows, or one that also hides the lamps' streaks. */
export type MirrorKind = 'shows' | 'hides';

/**
 * The floor's mirror of everything on it (floor mirror spec §3): images are plotted at full resolution, nearer over
 * farther, then blurred once at half resolution with a radius per row, so everything at the same place on the floor
 * blurs alike.
 */
export interface FloorMirror {
  /** Fits the mirror to a frame of this size, growing its buffers only when they must. */
  fit(width: number, height: number): void;
  /** Empties everything plotted since the last clear. */
  clear(): void;
  /** Covers pixel (x, y) with `colour`, a packed rgb(), over whatever was there. */
  plot(x: number, y: number, colour: number, kind: MirrorKind): void;
  /** Whether (x, y) was plotted, before the blur. */
  shownAt(x: number, y: number): boolean;
  /** Blurs what was plotted, frame row y by `radiusPx[y]` each way. */
  blur(radiusPx: Float64Array): void;
  /** The blurred coverage at (x, y), 0..1: of everything, and of the images that hide the lamps' streaks. */
  coverageAt(x: number, y: number): number;
  hidingAt(x: number, y: number): number;
  /** The frame rows the blurred mirror covers, [top, bottom); empty when they're equal. */
  readonly rows: { top: number; bottom: number };
  /** Adds `strength · weight[y]` of the mirror's colour to `fb`, on rows from `floorFrom[x]` down. */
  addInto(fb: Framebuffer, strength: number, weight: Float64Array, floorFrom: Int32Array): void;
}

/** Channels per half-resolution texel: r, g, b (times coverage), coverage, hiding coverage. */
const CHANNELS = 5;
const NOTHING = 0;
const SHOWS = 1;
const HIDES = 2;

export function createFloorMirror(): FloorMirror {
  let width = 0;
  let height = 0;
  let colours = new Uint32Array(0);
  let kinds = new Uint8Array(0);
  /** Plotted rows, [top, bottom). */
  let plottedTop = 0;
  let plottedBottom = 0;
  let halfWidth = 0;
  let halfHeight = 0;
  let texels = new Float32Array(0);
  /** One half-resolution row or column of one channel, and a column's running totals. */
  let line = new Float64Array(0);
  let totals = new Float64Array(0);
  /** The blurred half-resolution rows, [top, bottom). */
  let blurredTop = 0;
  let blurredBottom = 0;
  const rows = { top: 0, bottom: 0 };

  const halfRadius = (radiusPx: Float64Array, halfRow: number) =>
    Math.round((radiusPx[Math.min(height - 1, halfRow * 2)] as number) / 2);

  const downsample = () => {
    for (let hy = blurredTop; hy < blurredBottom; hy++) {
      for (let hx = 0; hx < halfWidth; hx++) {
        const at = (hy * halfWidth + hx) * CHANNELS;
        for (let dy = 0; dy < 2; dy++) {
          const y = hy * 2 + dy;
          for (let dx = 0; dx < 2 && y < height; dx++) {
            const x = hx * 2 + dx;
            const kind = x < width ? (kinds[y * width + x] as number) : NOTHING;
            if (kind === NOTHING) {
              continue;
            }
            const c = colours[y * width + x] as number;
            texels[at] = (texels[at] as number) + (c & 0xff) / 4;
            texels[at + 1] = (texels[at + 1] as number) + ((c >>> 8) & 0xff) / 4;
            texels[at + 2] = (texels[at + 2] as number) + ((c >>> 16) & 0xff) / 4;
            texels[at + 3] = (texels[at + 3] as number) + 1 / 4;
            if (kind === HIDES) {
              texels[at + 4] = (texels[at + 4] as number) + 1 / 4;
            }
          }
        }
      }
    }
  };

  /** Across each row: a running sum over the row's window; past the row's ends counts as empty. */
  const blurAcross = (radiusPx: Float64Array) => {
    for (let hy = blurredTop; hy < blurredBottom; hy++) {
      const radius = halfRadius(radiusPx, hy);
      if (radius === 0) {
        continue;
      }
      const span = 2 * radius + 1;
      for (let ch = 0; ch < CHANNELS; ch++) {
        for (let hx = 0; hx < halfWidth; hx++) {
          line[hx] = texels[(hy * halfWidth + hx) * CHANNELS + ch] as number;
        }
        let sum = 0;
        for (let hx = 0; hx < Math.min(radius, halfWidth); hx++) {
          sum += line[hx] as number;
        }
        for (let hx = 0; hx < halfWidth; hx++) {
          if (hx + radius < halfWidth) {
            sum += line[hx + radius] as number;
          }
          if (hx - radius - 1 >= 0) {
            sum -= line[hx - radius - 1] as number;
          }
          texels[(hy * halfWidth + hx) * CHANNELS + ch] = sum / span;
        }
      }
    }
  };

  /** Down each column: running totals, so each row takes its own window. */
  const blurDown = (radiusPx: Float64Array) => {
    for (let hx = 0; hx < halfWidth; hx++) {
      for (let ch = 0; ch < CHANNELS; ch++) {
        totals[0] = 0;
        for (let hy = blurredTop; hy < blurredBottom; hy++) {
          const i = hy - blurredTop;
          line[i] = texels[(hy * halfWidth + hx) * CHANNELS + ch] as number;
          totals[i + 1] = (totals[i] as number) + (line[i] as number);
        }
        for (let hy = blurredTop; hy < blurredBottom; hy++) {
          const radius = halfRadius(radiusPx, hy);
          const first = Math.max(blurredTop, hy - radius) - blurredTop;
          const last = Math.min(blurredBottom - 1, hy + radius) - blurredTop;
          texels[(hy * halfWidth + hx) * CHANNELS + ch] =
            ((totals[last + 1] as number) - (totals[first] as number)) / (2 * radius + 1);
        }
      }
    }
  };

  return {
    rows,
    fit(w, h) {
      if (w === width && h === height) {
        return;
      }
      width = w;
      height = h;
      halfWidth = Math.ceil(w / 2);
      halfHeight = Math.ceil(h / 2);
      if (colours.length < w * h) {
        colours = new Uint32Array(w * h);
        kinds = new Uint8Array(w * h);
      }
      kinds.fill(NOTHING);
      if (texels.length < halfWidth * halfHeight * CHANNELS) {
        texels = new Float32Array(halfWidth * halfHeight * CHANNELS);
      }
      texels.fill(0);
      line = new Float64Array(Math.max(halfWidth, halfHeight));
      totals = new Float64Array(halfHeight + 1);
      plottedTop = 0;
      plottedBottom = 0;
      blurredTop = 0;
      blurredBottom = 0;
      rows.top = 0;
      rows.bottom = 0;
    },
    clear() {
      kinds.fill(NOTHING, plottedTop * width, plottedBottom * width);
      texels.fill(0, blurredTop * halfWidth * CHANNELS, blurredBottom * halfWidth * CHANNELS);
      plottedTop = 0;
      plottedBottom = 0;
      blurredTop = 0;
      blurredBottom = 0;
      rows.top = 0;
      rows.bottom = 0;
    },
    plot(x, y, colour, kind) {
      colours[y * width + x] = colour;
      kinds[y * width + x] = kind === 'hides' ? HIDES : SHOWS;
      if (plottedBottom <= plottedTop) {
        plottedTop = y;
        plottedBottom = y + 1;
      } else {
        plottedTop = Math.min(plottedTop, y);
        plottedBottom = Math.max(plottedBottom, y + 1);
      }
    },
    shownAt(x, y) {
      return kinds[y * width + x] !== NOTHING;
    },
    blur(radiusPx) {
      if (plottedBottom <= plottedTop) {
        return;
      }
      let widest = 0;
      for (let y = plottedTop; y < plottedBottom; y++) {
        widest = Math.max(widest, radiusPx[y] as number);
      }
      const margin = Math.ceil(widest / 2) + 1;
      blurredTop = Math.max(0, (plottedTop >> 1) - margin);
      blurredBottom = Math.min(halfHeight, ((plottedBottom + 1) >> 1) + margin);
      downsample();
      blurAcross(radiusPx);
      blurDown(radiusPx);
      rows.top = blurredTop * 2;
      rows.bottom = Math.min(height, blurredBottom * 2);
    },
    coverageAt(x, y) {
      const hy = y >> 1;
      return hy < blurredTop || hy >= blurredBottom
        ? 0
        : (texels[(hy * halfWidth + (x >> 1)) * CHANNELS + 3] as number);
    },
    hidingAt(x, y) {
      const hy = y >> 1;
      return hy < blurredTop || hy >= blurredBottom
        ? 0
        : (texels[(hy * halfWidth + (x >> 1)) * CHANNELS + 4] as number);
    },
    addInto(fb, strength, weight, floorFrom) {
      const { pixels } = fb;
      for (let y = rows.top; y < rows.bottom; y++) {
        const k = strength * (weight[y] as number);
        if (k <= 0) {
          continue;
        }
        const halfRow = (y >> 1) * halfWidth;
        for (let x = 0; x < width; x++) {
          const at = (halfRow + (x >> 1)) * CHANNELS;
          if ((texels[at + 3] as number) <= 0 || y < (floorFrom[x] as number)) {
            continue;
          }
          const p = y * width + x;
          const c = pixels[p] as number;
          const r = Math.min(255, ((c & 0xff) + k * (texels[at] as number)) | 0);
          const g = Math.min(255, (((c >>> 8) & 0xff) + k * (texels[at + 1] as number)) | 0);
          const b = Math.min(255, (((c >>> 16) & 0xff) + k * (texels[at + 2] as number)) | 0);
          pixels[p] = ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
        }
      }
    },
  };
}
