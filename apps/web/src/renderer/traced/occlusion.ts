// Wall occlusion in the reflections, soft across screen columns (spec docs/superpowers/specs/2026-10-17-ray-traced-
// renderer-design.md §3.3). A reflection's cone spreads sideways over neighbouring columns, so what lies past a column's
// wall is not simply hidden: the cone sees it by the share of its sideways spread, a Gaussian across the columns, that
// falls on columns whose wall lies beyond it. Worked out per reflection column from what is listed once a frame, never
// per sample. Allocation-free once sized: the lists grow only when a frame has more lamps or columns than any before.
import type { NearbyThings } from './along-ray';

/** A Gaussian is cut off this many deviations out, as a blob is: sqrt(18), where e^-9 of its peak is left. */
const DEVIATIONS_TO_EDGE = Math.sqrt(18);
/** Wall distances are blended over this many deviations each side: further out a weight is under 1.2% of the middle's. */
const BLEND_DEVIATIONS = 3;
/** A lamp nearer the camera plane than this (tiles), or behind it, is taken to be this near: in front of every wall. */
const NEAREST_DEPTH = 0.05;
/** erf by Abramowitz and Stegun 7.1.26, to within 1.5e-7: Math has none. */
const ERF_P = 0.3275911;
const ERF_A1 = 0.254829592;
const ERF_A2 = -0.284496736;
const ERF_A3 = 1.421413741;
const ERF_A4 = -1.453152027;
const ERF_A5 = 1.061405429;

/** Where the eye is and which way it looks: a View will do. */
export interface ColumnsEye {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
}

/**
 * For each lamp near the eye (as NearbyThings lists them, `count` of them), the runs of reflection columns whose wall
 * lies beyond it, listed once a frame, and how much of it the cone from one column sees.
 */
export interface LampsPastWalls {
  count: number;
  columns: number;
  /** Per lamp, the cone's spread across at the lamp's depth, in columns: the deviation of its Gaussian. */
  deviation: Float64Array;
  /** Per lamp, how many runs it has, from lamp × runsPerLamp on: each its first and last column. */
  runs: Int32Array;
  runsPerLamp: number;
  runFirst: Int32Array;
  runLast: Int32Array;
  /** Per lamp, how much of it (0..1) the cone from the column last looked from sees: set by seeLampsFrom. */
  shown: Float64Array;
}

/** The share of a unit Gaussian below `z` deviations: exactly 0 or 1 past DEVIATIONS_TO_EDGE of them. */
export function gaussianBelow(z: number): number {
  if (z <= -DEVIATIONS_TO_EDGE) {
    return 0;
  }
  if (z >= DEVIATIONS_TO_EDGE) {
    return 1;
  }
  const x = Math.abs(z) * Math.SQRT1_2;
  const t = 1 / (1 + ERF_P * x);
  const erf = 1 - ((((ERF_A5 * t + ERF_A4) * t + ERF_A3) * t + ERF_A2) * t + ERF_A1) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 + 0.5 * erf : 0.5 - 0.5 * erf;
}

export function createLampsPastWalls(): LampsPastWalls {
  return {
    count: 0,
    columns: 0,
    deviation: new Float64Array(0),
    runs: new Int32Array(0),
    runsPerLamp: 0,
    runFirst: new Int32Array(0),
    runLast: new Int32Array(0),
    shown: new Float64Array(0),
  };
}

/**
 * Lists into `out`, for each of `lamps`, the runs of columns whose wall (`wallDistance`, per column, perpendicular to
 * the camera plane) lies beyond it, and the cone's spread across at its depth: `spreadTiles`, `columnsPerTile` columns
 * to a tile at a depth of one tile.
 */
export function findLampsPastWalls(
  lamps: NearbyThings,
  eye: ColumnsEye,
  wallDistance: Float64Array,
  columnsPerTile: number,
  spreadTiles: number,
  out: LampsPastWalls
): void {
  fitLampsPastWalls(out, lamps.count, wallDistance.length);
  for (let lamp = 0; lamp < lamps.count; lamp++) {
    const depth = Math.max(
      NEAREST_DEPTH,
      ((lamps.x[lamp] ?? 0) - eye.x) * eye.dirX + ((lamps.y[lamp] ?? 0) - eye.y) * eye.dirY
    );
    out.deviation[lamp] = (spreadTiles * columnsPerTile) / depth;
    listRunsPast(wallDistance, depth, lamp, out);
  }
}

/** Sets `out.shown`: how much of each lamp the cone from column `col` sees past the walls. */
export function seeLampsFrom(out: LampsPastWalls, col: number): void {
  for (let lamp = 0; lamp < out.count; lamp++) {
    out.shown[lamp] = shareSeenFrom(out, lamp, col);
  }
}

/**
 * Per column, into `out`: its wall's distance (`distance`, per column) blended over its neighbours by a Gaussian as wide
 * as the cone's spread across (`spreadTiles`) at that wall, `columnsPerTile` columns to a tile at a depth of one tile.
 * Blended as nearness (1 / distance), so a column with no wall in reach (Infinity) adds none.
 */
export function softenWallDistances(
  distance: Float64Array,
  columnsPerTile: number,
  spreadTiles: number,
  out: Float64Array
): void {
  const columns = distance.length;
  for (let col = 0; col < columns; col++) {
    const own = distance[col] ?? 0;
    const deviation = (spreadTiles * columnsPerTile) / own;
    const reach = Math.min(Math.max(col, columns - 1 - col), Math.floor(BLEND_DEVIATIONS * deviation));
    // The weights e^(-k^2 / 2 deviation^2), stepped without an exp per column: each is the last times a ratio that
    // shrinks by the same factor every step.
    const shrink = Math.exp(-1 / (deviation * deviation));
    let ratio = Math.exp(-1 / (2 * deviation * deviation));
    let weight = 1;
    let weights = 1;
    let nearness = 1 / own;
    for (let offset = 1; offset <= reach; offset++) {
      weight *= ratio;
      ratio *= shrink;
      if (col - offset >= 0) {
        weights += weight;
        nearness += weight / (distance[col - offset] ?? 0);
      }
      if (col + offset < columns) {
        weights += weight;
        nearness += weight / (distance[col + offset] ?? 0);
      }
    }
    out[col] = weights / nearness;
  }
}

/** Makes room in `out` for `lamps` lamps over `columns` columns, growing its arrays only when they are too small. */
function fitLampsPastWalls(out: LampsPastWalls, lamps: number, columns: number): void {
  const runsPerLamp = (columns + 1) >> 1;
  if (out.deviation.length < lamps) {
    out.deviation = new Float64Array(lamps);
    out.runs = new Int32Array(lamps);
    out.shown = new Float64Array(lamps);
  }
  if (out.runFirst.length < lamps * runsPerLamp) {
    out.runFirst = new Int32Array(lamps * runsPerLamp);
    out.runLast = new Int32Array(lamps * runsPerLamp);
  }
  out.count = lamps;
  out.columns = columns;
  out.runsPerLamp = runsPerLamp;
}

/** Lists the runs of columns whose wall lies beyond `depth`, as lamp `lamp`'s runs. */
function listRunsPast(wallDistance: Float64Array, depth: number, lamp: number, out: LampsPastWalls): void {
  const first = lamp * out.runsPerLamp;
  let runs = 0;
  let inRun = false;
  for (let col = 0; col < out.columns; col++) {
    const past = (wallDistance[col] ?? 0) > depth;
    if (past && !inRun) {
      out.runFirst[first + runs] = col;
    } else if (!past && inRun) {
      out.runLast[first + runs] = col - 1;
      runs++;
    }
    inRun = past;
  }
  if (inRun) {
    out.runLast[first + runs] = out.columns - 1;
    runs++;
  }
  out.runs[lamp] = runs;
}

/**
 * How much of lamp `lamp` the cone from column `col` sees: the share of its Gaussian that falls on the lamp's runs, each
 * column a unit wide, out of the share that falls on the screen (columns off it are not known, so not counted).
 */
function shareSeenFrom(out: LampsPastWalls, lamp: number, col: number): number {
  const runs = out.runs[lamp] ?? 0;
  const deviation = out.deviation[lamp] ?? 1;
  const first = lamp * out.runsPerLamp;
  let seen = 0;
  for (let run = first; run < first + runs; run++) {
    seen +=
      gaussianBelow(((out.runLast[run] ?? 0) + 0.5 - col) / deviation) -
      gaussianBelow(((out.runFirst[run] ?? 0) - 0.5 - col) / deviation);
  }
  if (seen <= 0) {
    return 0;
  }
  const onScreen = gaussianBelow((out.columns - 0.5 - col) / deviation) - gaussianBelow((-0.5 - col) / deviation);
  return seen >= onScreen ? 1 : seen / onScreen;
}
