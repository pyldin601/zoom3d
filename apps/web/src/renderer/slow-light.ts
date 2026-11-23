// Slow light's bend (D39, made exact in D40): the room is drawn into a wide source frame, then every pixel of the frame
// is read from the direction its light really came from (aberration, in both axes) and its colour seen through the
// Doppler shift of its spectrum. The map is smooth, so it is exact on a coarse grid and interpolated in between.
import { createFramebuffer, type Framebuffer } from './framebuffer';
import { aberrate, type Dir, dopplerAlong, MAX_BETA, type Motion } from './slow-light-math';
import { DOPPLER_STEPS, dopplerIndex, linearToSrgbByte, SHIFT_MATRICES, SRGB_TO_LINEAR, shiftOf } from './spectrum';

/** The source frame is this many times the frame's width; soft is fine (owner, 2026-11-22). */
const SOURCE_WIDTH_FACTOR = 2;
/** Grid points are this many frame pixels apart: the map is exact there and bilinear in between. */
export const GRID_PX = 8;
/** The source is fitted to the widest direction any motion at MAX_BETA reads, plus this much. */
const FIT_MARGIN = 1.02;
/** Motion directions tried when fitting, degrees apart. */
const FIT_STEP_DEG = 5;

/** Where a source point shows in the frame, and how much larger it is drawn there. */
export interface Shown {
  x: number;
  y: number;
  scale: number;
}

export interface Bend {
  /** Grid points per row and per column: `gridCols × gridRows`, row-major. */
  readonly gridCols: number;
  readonly gridRows: number;
  /** Per grid point: the source pixel position (fractional) it reads, and its Doppler factor's table index. */
  readonly gridX: Float32Array;
  readonly gridY: Float32Array;
  readonly gridD: Float32Array;
  /** The source columns [readFrom, readTo) the frame reads: the room need be drawn only there. */
  readonly readFrom: number;
  readonly readTo: number;
  /** The source frame for `output`: the same object until the output's size or FOV changes. */
  fit(output: Framebuffer): Framebuffer;
  /** Fills the grid for `output` and `motion`; a no-op when neither changed. */
  aim(output: Framebuffer, motion: Motion): void;
  /** Draws `source`, bent and shifted in colour, into `output`. */
  apply(source: Framebuffer, output: Framebuffer): void;
  /** Where source point (x, y) shows in the frame; false when the frame doesn't show it. */
  toOutput(sourceX: number, sourceY: number, out: Shown): boolean;
}

const projOf = (fb: Pick<Framebuffer, 'width' | 'fov'>) => fb.width / 2 / Math.tan(fb.fov / 2);

/** The direction frame pixel position (x, y) looks along, for a frame of this size and projection. */
function lookAlong(x: number, y: number, width: number, height: number, proj: number, out: Dir): Dir {
  const dy = (x - width / 2) / proj;
  const dz = (y - height / 2) / proj;
  const length = Math.hypot(1, dy, dz);
  out.x = 1 / length;
  out.y = dy / length;
  out.z = dz / length;
  return out;
}

/** The grid's positions along one axis of `size` pixels: every GRID_PX, and the far edge. */
function gridPositions(size: number): Float32Array {
  const count = Math.ceil(size / GRID_PX) + 1;
  return Float32Array.from({ length: count }, (_, i) => Math.min(i * GRID_PX, size));
}

export function createBend(): Bend {
  let source: Framebuffer | null = null;
  let fittedTo = { width: 0, height: 0, fov: 0 };
  let projOut = 1;
  let projSrc = 1;
  let colsAt: Float32Array = new Float32Array(0);
  let rowsAt: Float32Array = new Float32Array(0);
  let gridX = new Float32Array(0);
  let gridY = new Float32Array(0);
  let gridD = new Float32Array(0);
  /** Per frame column: the source column read at the eye row, for the frame's zbuffer. */
  let zbufferCol = new Int32Array(0);
  /** One row of grid values, interpolated down to the pixel row being drawn. */
  let rowX = new Float32Array(0);
  let rowY = new Float32Array(0);
  let rowD = new Float32Array(0);
  let readFrom = 0;
  let readTo = 0;
  let aimedBeta = Number.NaN;
  let aimedAngle = Number.NaN;
  /** Scratch directions: the one a pixel looks along, and the one its light came from. */
  const lookDir: Dir = { x: 0, y: 0, z: 0 };
  const sourceDir: Dir = { x: 0, y: 0, z: 0 };

  /** Where light seen at frame position (x, y) came from, into `sourceDir`, for motion at `beta` toward `angle`. */
  const readDirection = (x: number, y: number, width: number, height: number, angle: number, beta: number): Dir =>
    aberrate(lookAlong(x, y, width, height, projOut, lookDir), angle, beta, sourceDir);
  /** The source column a direction lands on, fractional. */
  const sourceColumn = (dir: Dir, sourceWidth: number) => sourceWidth / 2 + (projSrc * dir.y) / dir.x;

  /** The widest |y/x| and |z/x| of the source directions any motion at MAX_BETA reads along the frame's border. */
  const widestRead = (width: number, height: number) => {
    let across = 0;
    let down = 0;
    for (let deg = 0; deg < 360; deg += FIT_STEP_DEG) {
      const angle = (deg * Math.PI) / 180;
      for (let t = 0; t <= 1; t += 1 / 64) {
        for (const [x, y] of [
          [t * width, 0],
          [t * width, height],
          [0, t * height],
          [width, t * height],
        ] as const) {
          const dir = readDirection(x, y, width, height, angle, MAX_BETA);
          across = Math.max(across, Math.abs(dir.y / dir.x));
          down = Math.max(down, Math.abs(dir.z / dir.x));
        }
      }
    }
    return { across: across * FIT_MARGIN, down: down * FIT_MARGIN };
  };

  const fit = (output: Framebuffer): Framebuffer => {
    const fitted = fittedTo.width === output.width && fittedTo.height === output.height && fittedTo.fov === output.fov;
    if (source !== null && fitted) {
      return source;
    }
    projOut = projOf(output);
    const widest = widestRead(output.width, output.height);
    const width = output.width * SOURCE_WIDTH_FACTOR;
    projSrc = width / 2 / widest.across;
    const height = Math.ceil(2 * projSrc * widest.down);
    const made = createFramebuffer(width, height, 2 * Math.atan(widest.across));
    source = made;
    fittedTo = { width: output.width, height: output.height, fov: output.fov };
    colsAt = gridPositions(output.width);
    rowsAt = gridPositions(output.height);
    const points = colsAt.length * rowsAt.length;
    gridX = new Float32Array(points);
    gridY = new Float32Array(points);
    gridD = new Float32Array(points);
    zbufferCol = new Int32Array(output.width);
    rowX = new Float32Array(colsAt.length);
    rowY = new Float32Array(colsAt.length);
    rowD = new Float32Array(colsAt.length);
    aimedBeta = Number.NaN;
    return made;
  };

  /** The frame's zbuffer, read from the source column each frame column shows at the eye row. */
  const copyZbuffer = (src: Framebuffer, output: Framebuffer) => {
    for (let col = 0; col < output.width; col++) {
      output.zbuffer[col] = src.zbuffer[zbufferCol[col] as number] as number;
    }
  };

  /** Fills rowX, rowY and rowD with the grid's values interpolated down to frame row `y`. */
  const interpolateGridRow = (y: number) => {
    const cols = colsAt.length;
    const centreY = y + 0.5;
    const j = Math.min(rowsAt.length - 2, Math.floor(centreY / GRID_PX));
    const top = rowsAt[j] as number;
    const ty = (centreY - top) / ((rowsAt[j + 1] as number) - top);
    for (let i = 0; i < cols; i++) {
      const a = j * cols + i;
      const b = a + cols;
      rowX[i] = (gridX[a] as number) + ((gridX[b] as number) - (gridX[a] as number)) * ty;
      rowY[i] = (gridY[a] as number) + ((gridY[b] as number) - (gridY[a] as number)) * ty;
      rowD[i] = (gridD[a] as number) + ((gridD[b] as number) - (gridD[a] as number)) * ty;
    }
  };

  /** Where light from source point (x, y) is seen, into `lookDir`; false when it is behind the eye. */
  const seenFrom = (src: Framebuffer, x: number, y: number) => {
    aberrate(lookAlong(x, y, src.width, src.height, projSrc, sourceDir), aimedAngle, -aimedBeta, lookDir);
    return lookDir.x > 0;
  };

  const bend: Bend = {
    get gridCols() {
      return colsAt.length;
    },
    get gridRows() {
      return rowsAt.length;
    },
    get gridX() {
      return gridX;
    },
    get gridY() {
      return gridY;
    },
    get gridD() {
      return gridD;
    },
    get readFrom() {
      return readFrom;
    },
    get readTo() {
      return readTo;
    },
    fit,
    aim(output, motion) {
      const src = fit(output);
      if (motion.beta === aimedBeta && motion.angle === aimedAngle) {
        return;
      }
      aimedBeta = motion.beta;
      aimedAngle = motion.angle;
      let lowest = src.width;
      let highest = 0;
      const cols = colsAt.length;
      for (let j = 0; j < rowsAt.length; j++) {
        for (let i = 0; i < cols; i++) {
          const x = colsAt[i] as number;
          const y = rowsAt[j] as number;
          const dir = readDirection(x, y, output.width, output.height, motion.angle, motion.beta);
          const sx = sourceColumn(dir, src.width);
          gridX[j * cols + i] = sx;
          gridY[j * cols + i] = src.height / 2 + (projSrc * dir.z) / dir.x;
          gridD[j * cols + i] = dopplerIndex(dopplerAlong(lookDir, motion.angle, motion.beta));
          lowest = Math.min(lowest, sx);
          highest = Math.max(highest, sx);
        }
      }
      readFrom = Math.max(0, Math.floor(lowest) - 1);
      readTo = Math.min(src.width, Math.ceil(highest) + 2);
      for (let col = 0; col < output.width; col++) {
        const dir = readDirection(col + 0.5, output.height / 2, output.width, output.height, motion.angle, motion.beta);
        zbufferCol[col] = Math.min(src.width - 1, Math.max(0, Math.floor(sourceColumn(dir, src.width))));
      }
    },
    apply(src, output) {
      const { width, height } = output;
      const cols = colsAt.length;
      const lastSrcX = src.width - 1;
      const lastSrcY = src.height - 1;
      const srcPixels = src.pixels;
      const out = output.pixels;
      copyZbuffer(src, output);
      for (let y = 0; y < height; y++) {
        interpolateGridRow(y);
        const row = y * width;
        for (let x = 0; x < width; x++) {
          const centreX = x + 0.5;
          const i = Math.min(cols - 2, (centreX / GRID_PX) | 0);
          const left = colsAt[i] as number;
          const tx = (centreX - left) / ((colsAt[i + 1] as number) - left);
          const sx = ((rowX[i] as number) + ((rowX[i + 1] as number) - (rowX[i] as number)) * tx) | 0;
          const sy = ((rowY[i] as number) + ((rowY[i + 1] as number) - (rowY[i] as number)) * tx) | 0;
          const c = srcPixels[
            (sy < 0 ? 0 : sy > lastSrcY ? lastSrcY : sy) * src.width + (sx < 0 ? 0 : sx > lastSrcX ? lastSrcX : sx)
          ] as number;
          const eyeD = (rowD[i] as number) + ((rowD[i + 1] as number) - (rowD[i] as number)) * tx;
          const d = (eyeD + shiftOf(c) + 0.5) | 0;
          const m = (d < 0 ? 0 : d >= DOPPLER_STEPS ? DOPPLER_STEPS - 1 : d) * 9;
          const r = SRGB_TO_LINEAR[c & 0xff] as number;
          const g = SRGB_TO_LINEAR[(c >>> 8) & 0xff] as number;
          const b = SRGB_TO_LINEAR[(c >>> 16) & 0xff] as number;
          const outR = linearToSrgbByte(
            (SHIFT_MATRICES[m] as number) * r +
              (SHIFT_MATRICES[m + 1] as number) * g +
              (SHIFT_MATRICES[m + 2] as number) * b
          );
          const outG = linearToSrgbByte(
            (SHIFT_MATRICES[m + 3] as number) * r +
              (SHIFT_MATRICES[m + 4] as number) * g +
              (SHIFT_MATRICES[m + 5] as number) * b
          );
          const outB = linearToSrgbByte(
            (SHIFT_MATRICES[m + 6] as number) * r +
              (SHIFT_MATRICES[m + 7] as number) * g +
              (SHIFT_MATRICES[m + 8] as number) * b
          );
          out[row + x] = (0xff000000 | (outB << 16) | (outG << 8) | outR) >>> 0;
        }
      }
    },
    toOutput(sourceX, sourceY, out) {
      const src = source;
      if (src === null || Number.isNaN(aimedBeta) || !seenFrom(src, sourceX, sourceY)) {
        return false;
      }
      const { width, height } = fittedTo;
      out.x = width / 2 + (projOut * lookDir.y) / lookDir.x;
      out.y = height / 2 + (projOut * lookDir.z) / lookDir.x;
      if (!(out.x >= 0 && out.x < width)) {
        return false;
      }
      // How much taller things are drawn here: one source row further down, in frame rows.
      seenFrom(src, sourceX, sourceY + 1);
      out.scale = Math.abs(height / 2 + (projOut * lookDir.z) / lookDir.x - out.y);
      return true;
    },
  };
  return bend;
}
