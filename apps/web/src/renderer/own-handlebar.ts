// The scooter's handlebar in first person while riding (electric scooter spec §4.3): the top of the stem comes up from
// the bottom centre with the bar across it and a grip at each end. Steering tilts it (one grip up, the other down) and
// shifts it toward the turn. It never bobs: an electric scooter glides.
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
const LEFT_HALF = ['kkk.......', 'kKkmmmmmmm', 'kkkMMMMMMM', 'kkk.......'];
const BAR_ROWS = LEFT_HALF.map((row) => row + [...row].reverse().join(''));
const BAR_WIDTH = BAR_ROWS[0]?.length ?? 0;
/** The bar a column at a time, made once: each column is drawn at its own height, so a tilt slopes the bar. */
const BAR_COLUMNS: readonly HeldSprite[] = Array.from({ length: BAR_WIDTH }, (_, u) =>
  toHeldSprite(
    BAR_ROWS.map((row) => row.charAt(u)),
    PALETTE
  )
);
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
  const half = (BAR_WIDTH - 1) / 2;
  const left = centre - (BAR_WIDTH / 2) * t;
  // A loop, not forEach: drawn every frame, and a callback would be a new closure each time.
  for (let u = 0; u < BAR_COLUMNS.length; u++) {
    const column = BAR_COLUMNS.at(u);
    if (!column) {
      continue;
    }
    // Steering right drops the right grip and lifts the left one, the bar sloping evenly between them.
    const drop = (steer * HANDLEBAR_TILT_TEXELS * t * (u - half)) / half;
    blitHeldSprite(fb, column, left + u * t, barTop + drop, t, OVER_EVERYTHING);
  }
}
