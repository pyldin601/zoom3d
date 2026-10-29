// What a portal window does to the room seen through it: a pink shimmer rolling across it and a pink rim at its edges
// (portal glow spec §2.3). Pure but for the ripple's column stepper; the numbers come from the sketch, drawn on a
// 320-pixel-wide frame.
import type { Portal } from '@zoom3d/shared';
import { PORTAL_PINK } from '../game/portal-pulse';
import type { View } from './camera';

/** The frame width the sketch's numbers were tuned on, px. */
const SKETCH_WIDTH_PX = 320;
const SHIMMER_BASE = 0.16;
const SHIMMER_PER_PULSE = 0.2;
const SHIMMER_PER_RIPPLE = 0.1;
/** The shimmer mixes in this share of pink, so a fully shimmered pixel is a little darker than the glow. */
const SHIMMER_PINK = 0.9;
const RIPPLE_PER_ROW = 0.32;
const RIPPLE_PER_COL = 0.06;
const RIPPLE_RAD_PER_S = 5.5;
/** The rim's fall-off length, in sketch pixels. */
const RIM_FALLOFF_PX = 2.2;
const RIM_BASE = 0.35;
const RIM_PER_PULSE = 0.65;
/** Past this, sketch px, the rim adds under half a colour level: it is skipped. */
const RIM_REACH_PX = RIM_FALLOFF_PX * Math.log(2 * 255);
const OPENING_HALF_WIDTH_TILES = 0.5;

const PINK_R = PORTAL_PINK.r * 255;
const PINK_G = PORTAL_PINK.g * 255;
const PINK_B = PORTAL_PINK.b * 255;

/**
 * A packed colour as seen through a window: pulled toward pink by the shimmer, with the rim's pink added and each
 * channel clamped. `pulse` and `ripple` are 0..1; `edge` is the distance to the opening's nearest edge, sketch px.
 */
export function shimmerAndRim(pixel: number, pulse: number, ripple: number, edge: number): number {
  const k = SHIMMER_BASE + SHIMMER_PER_PULSE * pulse + SHIMMER_PER_RIPPLE * ripple;
  const kept = 1 - k;
  const rim = edge < RIM_REACH_PX ? Math.exp(-edge / RIM_FALLOFF_PX) * (RIM_BASE + RIM_PER_PULSE * pulse) : 0;
  const pink = SHIMMER_PINK * k + rim;
  const r = Math.min(255, (pixel & 0xff) * kept + PINK_R * pink) | 0;
  const g = Math.min(255, ((pixel >>> 8) & 0xff) * kept + PINK_G * pink) | 0;
  const b = Math.min(255, ((pixel >>> 16) & 0xff) * kept + PINK_B * pink) | 0;
  return ((pixel & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

/** The shimmer's slow wave at this pixel, 0..1: the same on screen whatever the frame's width. */
export function windowRipple(row: number, col: number, frameWidth: number, seconds: number): number {
  const toSketch = SKETCH_WIDTH_PX / frameWidth;
  return (
    0.5 + 0.5 * Math.sin(row * toSketch * RIPPLE_PER_ROW + col * toSketch * RIPPLE_PER_COL - seconds * RIPPLE_RAD_PER_S)
  );
}

/**
 * The ripple down one column, row by row, by turning its phase: a sine per pixel cost 0.8 ms of a 5 ms portals-on
 * frame (bench:sprites).
 */
interface RippleColumn {
  sin: number;
  cos: number;
  /** The phase turned by one row. */
  stepSin: number;
  stepCos: number;
}

const rippleColumn: RippleColumn = { sin: 0, cos: 0, stepSin: 0, stepCos: 0 };

/** Starts the ripple down column `col` at row `fromRow`; read it with `nextRippleDown`. */
export function startRippleDown(fromRow: number, col: number, frameWidth: number, seconds: number): void {
  const toSketch = SKETCH_WIDTH_PX / frameWidth;
  const phase = fromRow * toSketch * RIPPLE_PER_ROW + col * toSketch * RIPPLE_PER_COL - seconds * RIPPLE_RAD_PER_S;
  const step = toSketch * RIPPLE_PER_ROW;
  rippleColumn.sin = Math.sin(phase);
  rippleColumn.cos = Math.cos(phase);
  rippleColumn.stepSin = Math.sin(step);
  rippleColumn.stepCos = Math.cos(step);
}

/** The ripple at the column's next row, as `windowRipple` gives it, 0..1. */
export function nextRippleDown(): number {
  const { sin, cos, stepSin, stepCos } = rippleColumn;
  rippleColumn.sin = sin * stepCos + cos * stepSin;
  rippleColumn.cos = cos * stepCos - sin * stepSin;
  return 0.5 + 0.5 * sin;
}

/**
 * How far the column's ray meets the portal's plane from the opening's nearer side, sketch px at that depth. `depth`
 * is the plane's, in tiles along the view; `col` may be fractional.
 */
export function openingEdge(view: View, portal: Portal, col: number, depth: number, frameWidth: number): number {
  const camX = (2 * (col + 0.5)) / frameWidth - 1;
  const hitX = view.x + depth * (view.dirX + view.planeX * camX);
  const hitY = view.y + depth * (view.dirY + view.planeY * camX);
  // (−ny, nx) runs along the opening.
  const along = (hitX - portal.cx) * -portal.ny + (hitY - portal.cy) * portal.nx;
  return (OPENING_HALF_WIDTH_TILES - Math.abs(along)) * (view.proj / depth) * (SKETCH_WIDTH_PX / frameWidth);
}

/** Converts frame pixels to sketch pixels on a frame this wide. */
export const toSketchPx = (px: number, frameWidth: number) => px * (SKETCH_WIDTH_PX / frameWidth);
