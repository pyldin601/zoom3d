// Slow light's bend (D39): the room is drawn into a wide source frame, then each column of the frame is read from
// where aberration puts it and tinted by its Doppler factor. Vertical aberration is left out: only heights are matched.
import { createFramebuffer, type Framebuffer } from './framebuffer';
import {
  dopplerFactor,
  type Motion,
  type Rgb,
  SOURCE_FOV,
  SOURCE_WIDTH_FACTOR,
  sourceAngle,
  tintOf,
} from './slow-light-math';

export interface Bend {
  /** Per frame column: the source column it reads. */
  readonly sourceCol: Int32Array;
  /** Per frame column: how much taller things are drawn than in the source (k). */
  readonly rowScale: Float64Array;
  readonly gainR: Float32Array;
  readonly gainG: Float32Array;
  readonly gainB: Float32Array;
  /** The source frame for `output`: the same object until the output's size or FOV changes. */
  fit(output: Framebuffer): Framebuffer;
  /** Fills the column tables for `output` and `motion`; a no-op when neither changed. */
  aim(output: Framebuffer, motion: Motion): void;
  /** Draws `source`, bent and tinted, into `output`. */
  apply(source: Framebuffer, output: Framebuffer): void;
  /** The frame x (columns, fractional) a source x lands at. */
  toOutputX(sourceX: number): number;
  /** The height scale at frame x. */
  scaleAt(outputX: number): number;
}

const projOf = (fb: Pick<Framebuffer, 'width' | 'fov'>) => fb.width / 2 / Math.tan(fb.fov / 2);

export function createBend(): Bend {
  let source: Framebuffer | null = null;
  let fittedTo = { width: 0, height: 0, fov: 0 };
  let sourceCol = new Int32Array(0);
  /** The source x each frame column's centre reads, unrounded: toOutputX searches it. */
  let sourceX = new Float64Array(0);
  let rowScale = new Float64Array(0);
  let gainR = new Float32Array(0);
  let gainG = new Float32Array(0);
  let gainB = new Float32Array(0);
  let aimedBeta = Number.NaN;
  let aimedAngle = Number.NaN;
  const gain: Rgb = { r: 1, g: 1, b: 1 };

  const fit = (output: Framebuffer): Framebuffer => {
    const same =
      source !== null &&
      fittedTo.width === output.width &&
      fittedTo.height === output.height &&
      fittedTo.fov === output.fov;
    if (same && source) {
      return source;
    }
    const fitted = createFramebuffer(output.width * SOURCE_WIDTH_FACTOR, output.height, SOURCE_FOV);
    source = fitted;
    fittedTo = { width: output.width, height: output.height, fov: output.fov };
    sourceCol = new Int32Array(output.width);
    sourceX = new Float64Array(output.width);
    rowScale = new Float64Array(output.width);
    gainR = new Float32Array(output.width);
    gainG = new Float32Array(output.width);
    gainB = new Float32Array(output.width);
    aimedBeta = Number.NaN;
    return fitted;
  };

  const bend: Bend = {
    get sourceCol() {
      return sourceCol;
    },
    get rowScale() {
      return rowScale;
    },
    get gainR() {
      return gainR;
    },
    get gainG() {
      return gainG;
    },
    get gainB() {
      return gainB;
    },
    fit,
    aim(output, motion) {
      const src = fit(output);
      if (motion.beta === aimedBeta && motion.angle === aimedAngle) {
        return;
      }
      aimedBeta = motion.beta;
      aimedAngle = motion.angle;
      const projOut = projOf(output);
      const projSrc = projOf(src);
      const halfOut = output.width / 2;
      const halfSrc = src.width / 2;
      for (let col = 0; col < output.width; col++) {
        const seen = Math.atan((col + 0.5 - halfOut) / projOut);
        const from = sourceAngle(seen, motion.angle, motion.beta);
        const x = halfSrc + Math.tan(from) * projSrc;
        sourceX[col] = x;
        sourceCol[col] = Math.min(src.width - 1, Math.max(0, Math.floor(x)));
        rowScale[col] = (projOut * Math.cos(from)) / (projSrc * Math.cos(seen));
        tintOf(dopplerFactor(seen, motion.angle, motion.beta), gain);
        gainR[col] = gain.r;
        gainG[col] = gain.g;
        gainB[col] = gain.b;
      }
    },
    apply(src, output) {
      const { width, height } = output;
      const half = height / 2;
      const lastRow = src.height - 1;
      const out = output.pixels;
      const pixels = src.pixels;
      for (let col = 0; col < width; col++) {
        output.zbuffer[col] = src.zbuffer[sourceCol[col] as number] as number;
      }
      for (let y = 0; y < height; y++) {
        const fromMiddle = y + 0.5 - half;
        const row = y * width;
        for (let col = 0; col < width; col++) {
          const sy = Math.floor(half + fromMiddle / (rowScale[col] as number));
          const srcRow = sy < 0 ? 0 : sy > lastRow ? lastRow : sy;
          const c = pixels[srcRow * src.width + (sourceCol[col] as number)] as number;
          const r = Math.min(255, (c & 0xff) * (gainR[col] as number));
          const g = Math.min(255, ((c >>> 8) & 0xff) * (gainG[col] as number));
          const b = Math.min(255, ((c >>> 16) & 0xff) * (gainB[col] as number));
          out[row + col] = ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
        }
      }
    },
    toOutputX(x) {
      const n = sourceX.length;
      if (n === 0 || x <= (sourceX[0] as number)) {
        return 0;
      }
      if (x >= (sourceX[n - 1] as number)) {
        return n;
      }
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((sourceX[mid] as number) <= x) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      const a = sourceX[lo] as number;
      const b = sourceX[hi] as number;
      return lo + 0.5 + (x - a) / (b - a);
    },
    scaleAt(x) {
      const col = Math.min(rowScale.length - 1, Math.max(0, Math.floor(x)));
      return rowScale[col] ?? 1;
    },
  };
  return bend;
}
