// The floor's mirror (floor mirror spec §3): the walls' images, copied flipped from the drawn frame straight into blur
// texels of SCALE × SCALE pixels, then the people's and objects', far to near, plotted at full resolution over them;
// all blurred once on the texels, with a radius that grows towards the eye.
// Under the people's and objects' images the floor's lamp reflections are hidden, as they stand in front of the
// lamps' in the floor; then the layer's colour is added. Allocation-free once the buffers fit the frame.
import type { Framebuffer } from './framebuffer';

/** What a plotted pixel of the floor mirror is: an image that shows, or one that also hides the lamps' streaks. */
export type MirrorKind = 'shows' | 'hides';

/**
 * The floor's mirror of everything on it (floor mirror spec §3): images are plotted at full resolution, nearer over
 * farther, then blurred once on coarse texels with a radius per row, so everything at the same place on the floor
 * blurs alike.
 */
export interface FloorMirror {
  /** Fits the mirror to a frame of this size, growing its buffers only when they must. */
  fit(width: number, height: number): void;
  /** Empties everything plotted since the last clear. */
  clear(): void;
  /**
   * The walls' images (floor mirror spec §3.2): under each column's wall in [fromCol, toCol), rows `end[col]` on, the
   * drawn wall's rows flipped about its foot, for the wall's height, on rows where `weight` > 0. A portal's window
   * (fb.portalAt) has none: its rows are drawn after the mirror. Call before plotting anything over them, and keep
   * `fb`'s walls as they are until the blur.
   */
  addWalls(
    fb: Framebuffer,
    start: Int32Array,
    end: Int32Array,
    weight: Float64Array,
    fromCol: number,
    toCol: number
  ): void;
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
  /**
   * Adds `strength · weight[y]` of the mirror's colour to `fb`'s columns [fromCol, toCol), on rows from `floorFrom[x]`
   * down.
   */
  addInto(
    fb: Framebuffer,
    strength: number,
    weight: Float64Array,
    floorFrom: Int32Array,
    fromCol: number,
    toCol: number
  ): void;
}

/** The mirror is blurred at 1/2^SHIFT of the frame's resolution (quarter: half measured 0.6 ms in bench:walls). */
const SHIFT = 2;
const SCALE = 1 << SHIFT;
/** Channels per texel: r, g, b (times coverage), coverage, hiding coverage. */
const CHANNELS = 5;
const NOTHING = 0;
const SHOWS = 1;
const HIDES = 2;

export function createFloorMirror(): FloorMirror {
  let width = 0;
  let height = 0;
  let colours = new Uint32Array(0);
  let kinds = new Uint8Array(0);
  /** Plotted rows, [top, bottom), and columns, [left, right). */
  let plottedTop = 0;
  let plottedBottom = 0;
  let plottedLeft = 0;
  let plottedRight = 0;
  /** Whether anything plotted hides the lamps' streaks. */
  let hides = false;
  /** The walls' images: the frame they're read from, and per column the wall's foot and the image's rows. */
  let wallPixels: Uint32Array = new Uint32Array(0);
  let wallFoot = new Int32Array(0);
  let imageFrom = new Int32Array(0);
  let imageTo = new Int32Array(0);
  /** Texel rows the walls' images touch, [top, bottom). */
  let wallTop = 0;
  let wallBottom = 0;
  let texelsAcross = 0;
  let texelsDown = 0;
  let texels = new Float32Array(0);
  /** One row of texels, a column's running totals and a row's running sums, every channel. */
  let line = new Float32Array(0);
  let totals = new Float64Array(0);
  const sums = new Float64Array(CHANNELS);
  /** Each frame pixel's share of its texel, per texel column and row: 1/SCALE, more in a frame's last, narrower ones. */
  let shareAcross = new Float32Array(0);
  let shareDown = new Float32Array(0);
  /** The blurred texel rows, [top, bottom). */
  let blurredTop = 0;
  let blurredBottom = 0;
  const rows = { top: 0, bottom: 0 };

  const texelRadius = (radiusPx: Float64Array, texelRow: number) =>
    Math.round((radiusPx[Math.min(height - 1, texelRow * SCALE)] as number) / SCALE);

  /** Pixel (x, y)'s share of its texel. */
  const shareOf = (x: number, y: number) => (shareAcross[x >> SHIFT] as number) * (shareDown[y >> SHIFT] as number);

  /** Adds pixel (x, y)'s share of colour `c` and of `coverage` to its texel. */
  const addShare = (x: number, y: number, c: number, coverage: number) => {
    const at = ((y >> SHIFT) * texelsAcross + (x >> SHIFT)) * CHANNELS;
    const k = coverage * shareOf(x, y);
    texels[at] = (texels[at] as number) + (c & 0xff) * k;
    texels[at + 1] = (texels[at + 1] as number) + ((c >>> 8) & 0xff) * k;
    texels[at + 2] = (texels[at + 2] as number) + ((c >>> 16) & 0xff) * k;
    texels[at + 3] = (texels[at + 3] as number) + k;
  };

  /** The plotted pixels into their texels, each over the wall's image it covers. */
  const downsample = () => {
    for (let y = plottedTop; y < plottedBottom; y++) {
      for (let x = plottedLeft; x < plottedRight; x++) {
        const kind = kinds[y * width + x] as number;
        if (kind === NOTHING) {
          continue;
        }
        if (y >= (imageFrom[x] as number) && y < (imageTo[x] as number)) {
          const foot = wallFoot[x] as number;
          addShare(x, y, wallPixels[(2 * foot - 1 - y) * width + x] as number, -1);
        }
        addShare(x, y, colours[y * width + x] as number, 1);
        if (kind === HIDES) {
          const at = ((y >> SHIFT) * texelsAcross + (x >> SHIFT)) * CHANNELS + 4;
          texels[at] = (texels[at] as number) + shareOf(x, y);
        }
      }
    }
  };

  /** The hiding coverage is blurred only when something hides: walls alone never do. */
  const blurredChannels = () => (hides ? CHANNELS : CHANNELS - 1);

  /**
   * How many texels of a window `radius` each way from `at` lie in the frame, `size` long: the window's average counts
   * only those, or an image would fade towards the frame's edges where the room goes on.
   */
  const inFrame = (at: number, radius: number, size: number) =>
    Math.min(at + radius, size - 1) - Math.max(at - radius, 0) + 1;

  /** Across each row: running sums of every channel at once over the row's window; past its ends counts as empty. */
  const blurAcross = (radiusPx: Float64Array) => {
    const channels = blurredChannels();
    for (let hy = blurredTop; hy < blurredBottom; hy++) {
      const radius = texelRadius(radiusPx, hy);
      if (radius === 0) {
        continue;
      }
      const row = hy * texelsAcross * CHANNELS;
      // Copied by hand: subarray() would make a view object per row.
      for (let i = 0; i < texelsAcross * CHANNELS; i++) {
        line[i] = texels[row + i] as number;
      }
      sums.fill(0);
      for (let hx = 0; hx < Math.min(radius, texelsAcross); hx++) {
        for (let ch = 0; ch < channels; ch++) {
          sums[ch] = (sums[ch] as number) + (line[hx * CHANNELS + ch] as number);
        }
      }
      for (let hx = 0; hx < texelsAcross; hx++) {
        const span = inFrame(hx, radius, texelsAcross);
        const entering = hx + radius < texelsAcross ? (hx + radius) * CHANNELS : -1;
        const leaving = hx - radius - 1 >= 0 ? (hx - radius - 1) * CHANNELS : -1;
        for (let ch = 0; ch < channels; ch++) {
          let sum = sums[ch] as number;
          if (entering >= 0) {
            sum += line[entering + ch] as number;
          }
          if (leaving >= 0) {
            sum -= line[leaving + ch] as number;
          }
          sums[ch] = sum;
          texels[row + hx * CHANNELS + ch] = sum / span;
        }
      }
    }
  };

  /** Down each column: running totals of every channel, so each row takes its own window. */
  const blurDown = (radiusPx: Float64Array) => {
    const channels = blurredChannels();
    for (let hx = 0; hx < texelsAcross; hx++) {
      for (let ch = 0; ch < channels; ch++) {
        totals[ch] = 0;
      }
      for (let hy = blurredTop; hy < blurredBottom; hy++) {
        const i = (hy - blurredTop + 1) * CHANNELS;
        const at = (hy * texelsAcross + hx) * CHANNELS;
        for (let ch = 0; ch < channels; ch++) {
          totals[i + ch] = (totals[i - CHANNELS + ch] as number) + (texels[at + ch] as number);
        }
      }
      for (let hy = blurredTop; hy < blurredBottom; hy++) {
        const radius = texelRadius(radiusPx, hy);
        const first = (Math.max(blurredTop, hy - radius) - blurredTop) * CHANNELS;
        const last = (Math.min(blurredBottom - 1, hy + radius) - blurredTop + 1) * CHANNELS;
        // Rows between the blurred ones and the frame's edges are empty; past the edges there's nothing to count.
        const span = inFrame(hy, radius, texelsDown);
        const at = (hy * texelsAcross + hx) * CHANNELS;
        for (let ch = 0; ch < channels; ch++) {
          texels[at + ch] = ((totals[last + ch] as number) - (totals[first + ch] as number)) / span;
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
      texelsAcross = Math.ceil(w / SCALE);
      texelsDown = Math.ceil(h / SCALE);
      shareAcross = Float32Array.from({ length: texelsAcross }, (_, i) => 1 / Math.min(SCALE, w - i * SCALE));
      shareDown = Float32Array.from({ length: texelsDown }, (_, i) => 1 / Math.min(SCALE, h - i * SCALE));
      if (colours.length < w * h) {
        colours = new Uint32Array(w * h);
        kinds = new Uint8Array(w * h);
      }
      kinds.fill(NOTHING);
      wallFoot = new Int32Array(w);
      imageFrom = new Int32Array(w);
      imageTo = new Int32Array(w);
      if (texels.length < texelsAcross * texelsDown * CHANNELS) {
        texels = new Float32Array(texelsAcross * texelsDown * CHANNELS);
      }
      texels.fill(0);
      line = new Float32Array(texelsAcross * CHANNELS);
      totals = new Float64Array((texelsDown + 1) * CHANNELS);
      plottedTop = 0;
      plottedBottom = 0;
      blurredTop = 0;
      blurredBottom = 0;
      rows.top = 0;
      rows.bottom = 0;
    },
    clear() {
      kinds.fill(NOTHING, plottedTop * width, plottedBottom * width);
      imageFrom.fill(0);
      imageTo.fill(0);
      wallTop = 0;
      wallBottom = 0;
      hides = false;
      texels.fill(0, blurredTop * texelsAcross * CHANNELS, blurredBottom * texelsAcross * CHANNELS);
      plottedTop = 0;
      plottedBottom = 0;
      blurredTop = 0;
      blurredBottom = 0;
      rows.top = 0;
      rows.bottom = 0;
    },
    addWalls(fb, start, end, weight, fromCol, toCol) {
      wallPixels = fb.pixels;
      const { pixels, portalAt } = fb;
      // Rows above `nearest` show no mirror: the weight only grows down the floor.
      let nearest = height;
      for (let y = height - 1; y >= 0 && (weight[y] as number) > 0; y--) {
        nearest = y;
      }
      for (let x = fromCol; x < toCol; x++) {
        if ((portalAt[x] as number) >= 0) {
          continue;
        }
        const foot = end[x] as number;
        const from = Math.max(foot, nearest);
        const to = Math.min(height, foot + (foot - (start[x] as number)));
        wallFoot[x] = foot;
        imageFrom[x] = from;
        imageTo[x] = Math.max(from, to);
        for (let y = from; y < to; y++) {
          addShare(x, y, pixels[(2 * foot - 1 - y) * width + x] as number, 1);
        }
        if (to > from) {
          wallTop = wallBottom > wallTop ? Math.min(wallTop, from >> SHIFT) : from >> SHIFT;
          wallBottom = Math.max(wallBottom, (to + SCALE - 1) >> SHIFT);
        }
      }
    },
    plot(x, y, colour, kind) {
      colours[y * width + x] = colour;
      kinds[y * width + x] = kind === 'hides' ? HIDES : SHOWS;
      hides ||= kind === 'hides';
      if (plottedBottom <= plottedTop) {
        plottedTop = y;
        plottedBottom = y + 1;
        plottedLeft = x;
        plottedRight = x + 1;
      } else {
        plottedTop = Math.min(plottedTop, y);
        plottedBottom = Math.max(plottedBottom, y + 1);
        plottedLeft = Math.min(plottedLeft, x);
        plottedRight = Math.max(plottedRight, x + 1);
      }
    },
    shownAt(x, y) {
      return kinds[y * width + x] !== NOTHING;
    },
    blur(radiusPx) {
      const plotted = plottedBottom > plottedTop;
      const walls = wallBottom > wallTop;
      if (!plotted && !walls) {
        return;
      }
      const top = Math.min(plotted ? plottedTop >> SHIFT : texelsDown, walls ? wallTop : texelsDown);
      const bottom = Math.max(plotted ? (plottedBottom + SCALE - 1) >> SHIFT : 0, walls ? wallBottom : 0);
      let widest = 0;
      for (let hy = top; hy < bottom; hy++) {
        widest = Math.max(widest, radiusPx[Math.min(height - 1, hy * SCALE)] as number);
      }
      const margin = Math.ceil(widest / SCALE) + 1;
      blurredTop = Math.max(0, top - margin);
      blurredBottom = Math.min(texelsDown, bottom + margin);
      downsample();
      blurAcross(radiusPx);
      blurDown(radiusPx);
      rows.top = blurredTop * SCALE;
      rows.bottom = Math.min(height, blurredBottom * SCALE);
    },
    coverageAt(x, y) {
      const hy = y >> SHIFT;
      return hy < blurredTop || hy >= blurredBottom
        ? 0
        : (texels[(hy * texelsAcross + (x >> SHIFT)) * CHANNELS + 3] as number);
    },
    hidingAt(x, y) {
      const hy = y >> SHIFT;
      return hy < blurredTop || hy >= blurredBottom
        ? 0
        : (texels[(hy * texelsAcross + (x >> SHIFT)) * CHANNELS + 4] as number);
    },
    addInto(fb, strength, weight, floorFrom, fromCol, toCol) {
      const { pixels } = fb;
      for (let y = rows.top; y < rows.bottom; y++) {
        const k = strength * (weight[y] as number);
        if (k <= 0) {
          continue;
        }
        const texelRow = (y >> SHIFT) * texelsAcross;
        for (let x = fromCol; x < toCol; x++) {
          const at = (texelRow + (x >> SHIFT)) * CHANNELS;
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
