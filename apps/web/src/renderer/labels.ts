// Name labels above avatars, drawn on the HUD canvas at full resolution.
import type { PlayerState } from '@zoom3d/shared';
import { createView, setView } from './camera';
import type { Framebuffer } from './framebuffer';
import type { Bend, Shown } from './slow-light';
import { type Projection, projectSprite } from './sprites';

/** Names show only for people this close (6d spec §4): a crowd of 100 labels is unreadable. */
export const LABEL_TILES = 10;
/** The font size, the outline's width and the gap above the disc, as fractions of the HUD's sizing height. */
const FONT_SIZE = 0.028;
const OUTLINE_WIDTH = 0.005;
const MIN_OUTLINE_PX = 2;
const GAP_ABOVE_DISC = 0.01;
const OUTLINE_COLOUR = 'rgba(0, 0, 0, 0.85)';
const TEXT_COLOUR = '#fff';

export interface NameLabel {
  /** Where the name appears to the local player: the person's place, or the doorway they are seen through. */
  shownX: number;
  shownY: number;
  name: string;
  mic: boolean;
}

const frameView = createView();
const projection: Projection = { screenX: 0, depth: 0, size: 0 };
const shown: Shown = { x: 0, y: 0, scale: 1 };

export function inLabelRange(p: { x: number; y: number }, x: number, y: number): boolean {
  return Math.hypot(x - p.x, y - p.y) <= LABEL_TILES;
}

/** Each person's name above their disc, where the disc's centre is in sight, on a HUD canvas over `fb`. */
export function drawLabels(
  ctx: CanvasRenderingContext2D,
  fb: Framebuffer,
  p: PlayerState,
  others: readonly NameLabel[],
  bend?: Bend | null
): void {
  // Bent by slow light, the discs were drawn in the bend's source frame: project there, then follow the bend.
  const drawn = bend ? bend.fit(fb) : fb;
  const view = setView(frameView, drawn, p);
  const { width: hudW, height: hudH } = ctx.canvas;
  const hudPerPixel = hudW / fb.width;
  // The HUD's height, but at most 16/9 of its width: the same as the height on desktop, not huge on a tall phone frame.
  const sizingHeight = Math.min(hudH, (hudW * 16) / 9);
  ctx.font = `${Math.round(sizingHeight * FONT_SIZE)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(MIN_OUTLINE_PX, sizingHeight * OUTLINE_WIDTH);
  for (const o of others) {
    if (
      !inLabelRange(p, o.shownX, o.shownY) ||
      !projectSprite(view, o.shownX, o.shownY, projection) ||
      centreHidden(drawn, projection)
    ) {
      continue;
    }
    // Through a bend the disc's centre shows somewhere else in the frame, and larger or smaller.
    if (bend && !bend.toOutput(projection.screenX, drawn.height / 2, shown)) {
      continue;
    }
    const screenX = bend ? shown.x : projection.screenX;
    const centreY = bend ? shown.y : fb.height / 2;
    const size = bend ? projection.size * shown.scale : projection.size;
    const x = screenX * hudPerPixel;
    const y = (centreY - size / 2) * hudPerPixel - sizingHeight * GAP_ABOVE_DISC;
    const text = o.mic ? o.name : `🔇 ${o.name}`;
    ctx.strokeStyle = OUTLINE_COLOUR;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = TEXT_COLOUR;
    ctx.fillText(text, x, y);
  }
}

/** Whether the disc's centre column is off the frame or behind its wall. */
function centreHidden(fb: Framebuffer, { screenX, depth }: Projection): boolean {
  const col = Math.round(screenX);
  return col < 0 || col >= fb.width || depth >= (fb.zbuffer[col] as number);
}
