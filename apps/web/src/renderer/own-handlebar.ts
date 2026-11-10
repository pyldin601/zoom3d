// The scooter's handlebar in first person while riding (electric scooter spec §4.3): the top of the stem comes up from
// the bottom centre with the bar across it and a grip at each end. Steering tilts it (one grip up, the other down) and
// shifts it toward the turn. It never bobs: an electric scooter glides. A fist holds each grip (owner, 2026-11-10: the
// hands were missing), in the floating hand's colours, the grip showing on both sides of it, and tilts with its grip.
import type { Framebuffer } from './framebuffer';
import { blitHeldSprite, type HeldSprite, OVER_EVERYTHING, toHeldSprite } from './held-items';
import { ownTexel } from './own-held';

/** How far each grip rises or drops at full steer, in texels. */
export const HANDLEBAR_TILT_TEXELS = 3;
/** How far the whole bar shifts toward the turn at full steer, as a fraction of the width. */
export const HANDLEBAR_SHIFT = 0.02;
/**
 * Turned this far past the edge of the view, the head no longer sees the bar at all, which is about half the screen
 * wide.
 */
const OUT_OF_VIEW_RAD = 0.6;
/** The bar's top, this many texels above the bottom edge. */
const BAR_RISE_TEXELS = 4.5;

const PALETTE: Readonly<Record<string, string>> = { m: '#aab0b8', M: '#6d737b', k: '#26262a', K: '#3d3d44' };
const LEFT_HALF = ['kkkkkk....', 'kKKKKkmmmm', 'kkkkkkMMMM', 'kkkkkk....'];
const BAR_ROWS = LEFT_HALF.map((row) => row + [...row].reverse().join(''));
const BAR_WIDTH = BAR_ROWS[0]?.length ?? 0;
/** The left fist, knuckles up; the outer side is column 0. */
const LEFT_FIST = ['ssss', 'slll', 'sllo', 'lloo', '.oo.'];
const FIST_WIDTH = LEFT_FIST[0]?.length ?? 0;
const RIGHT_FIST = LEFT_FIST.map((row) => [...row].reverse().join(''));
/** A sprite a column at a time, so it can slope with the bar like the bar's own columns. */
const columnsOf = (rows: readonly string[], palette?: Readonly<Record<string, string>>): readonly HeldSprite[] =>
  Array.from({ length: rows[0]?.length ?? 0 }, (_, u) =>
    toHeldSprite(
      rows.map((row) => row.charAt(u)),
      palette
    )
  );
/** The bar a column at a time, made once: each column is drawn at its own height, so a tilt slopes the bar. */
const BAR_COLUMNS = columnsOf(BAR_ROWS, PALETTE);
const LEFT_FIST_COLUMNS = columnsOf(LEFT_FIST);
const RIGHT_FIST_COLUMNS = columnsOf(RIGHT_FIST);
/**
 * The bar column each fist's first column sits on: the middle of its grip, which shows on both sides of the fist
 * (owner, 2026-11-10).
 */
const LEFT_FIST_U = 1;
const RIGHT_FIST_U = BAR_WIDTH - LEFT_FIST_U - FIST_WIDTH;

/** Taller than any bar ever rises: the bottom edge crops it. */
const STEM: HeldSprite = toHeldSprite(['mM', 'mM', 'mM', 'mM', 'mM', 'mM', 'mM'], PALETTE);

/**
 * `steer` −1..1: left to right. `head`: radians the head is turned from the scooter's heading. The bar stays with the
 * scooter, so it sits where straight ahead projects on screen.
 */
export function renderOwnHandlebar(fb: Framebuffer, steer: number, head = 0): void {
  if (Math.abs(head) >= fb.fov / 2 + OUT_OF_VIEW_RAD) {
    return;
  }
  const { width: w, height: h } = fb;
  const t = ownTexel(fb);
  const straightAhead = w / 2 - (Math.tan(head) / Math.tan(fb.fov / 2)) * (w / 2);
  const centre = straightAhead + steer * HANDLEBAR_SHIFT * w;
  const barTop = h - BAR_RISE_TEXELS * t;
  // The bar's middle rows sit on the stem's top.
  blitHeldSprite(fb, STEM, centre - t, barTop + t, t, OVER_EVERYTHING);
  const left = centre - (BAR_WIDTH / 2) * t;
  drawColumns(fb, BAR_COLUMNS, 0, left, barTop, t, steer);
  drawColumns(fb, LEFT_FIST_COLUMNS, LEFT_FIST_U, left, barTop, t, steer);
  drawColumns(fb, RIGHT_FIST_COLUMNS, RIGHT_FIST_U, left, barTop, t, steer);
}

/** Steering right drops the right grip and lifts the left one, the bar sloping evenly between them. */
function dropAt(u: number, steer: number, t: number): number {
  const half = (BAR_WIDTH - 1) / 2;
  return (steer * HANDLEBAR_TILT_TEXELS * t * (u - half)) / half;
}

/** Draws `columns` from bar column `firstU` on, each at that bar column's drop. */
function drawColumns(
  fb: Framebuffer,
  columns: readonly HeldSprite[],
  firstU: number,
  left: number,
  barTop: number,
  t: number,
  steer: number
): void {
  // A loop, not forEach: drawn every frame, and a callback would be a new closure each time.
  for (let c = 0; c < columns.length; c++) {
    const column = columns.at(c);
    if (column) {
      const u = firstU + c;
      blitHeldSprite(fb, column, left + u * t, barTop + dropAt(u, steer, t), t, OVER_EVERYTHING);
    }
  }
}
