// Name labels above avatars, drawn on the HUD canvas at full resolution.
import type { PlayerState } from '@zoom3d/shared';
import type { Framebuffer } from './framebuffer';
import { type Projection, projectSprite } from './sprites';

const projection: Projection = { screenX: 0, depth: 0, size: 0 };

export function drawLabels(
  ctx: CanvasRenderingContext2D,
  fb: Framebuffer,
  p: PlayerState,
  others: readonly { x: number; y: number; name: string; mic: boolean }[],
  hudW: number,
  hudH: number
): void {
  const scale = hudW / fb.width;
  // Text scales with the height a 16:9 frame of this width would have: the same as before on desktop, not huge on a
  // tall phone frame.
  const textH = Math.min(hudH, (hudW * 16) / 9);
  ctx.font = `${Math.round(textH * 0.028)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, textH * 0.005);
  for (const o of others) {
    if (!projectSprite(p, o.x, o.y, fb.width, fb.fov, projection)) {
      continue;
    }
    const col = Math.round(projection.screenX);
    if (col < 0 || col >= fb.width || projection.depth >= (fb.zbuffer[col] as number)) {
      continue;
    }
    const x = projection.screenX * scale;
    const y = (fb.height / 2 - projection.size / 2) * scale - textH * 0.01;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    const label = o.mic ? o.name : `🔇 ${o.name}`;
    ctx.strokeText(label, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x, y);
  }
}
