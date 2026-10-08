// Top-down automap drawn on the HUD canvas.
import { type GameMap, type PlayerState, tileAt } from '@zoom3d/shared';

const FILL = 0.9;
const ZONE_COLORS = ['', '#8c8e8c', '#7a5530', '#1a2cc0'];
const BACKDROP = 'rgba(0, 0, 0, 0.75)';
const PLAYER = '#ffd400';

export interface AutomapLayout {
  originX: number;
  originY: number;
  cell: number;
}

export function automapLayout(map: GameMap, hudW: number, hudH: number): AutomapLayout {
  const cell = Math.max(1, Math.floor(Math.min((hudW * FILL) / map.width, (hudH * FILL) / map.height)));
  return {
    originX: Math.floor((hudW - map.width * cell) / 2),
    originY: Math.floor((hudH - map.height * cell) / 2),
    cell,
  };
}

const visibleWalls = new WeakMap<GameMap, { x: number; y: number; tile: number }[]>();

/** Walls that touch floor (8-neighbourhood); the rest of the solid mass is never seen. */
function wallsToDraw(map: GameMap) {
  let walls = visibleWalls.get(map);
  if (walls) return walls;
  walls = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = tileAt(map, x, y);
      if (tile === 0) continue;
      let touchesFloor = false;
      for (let dy = -1; dy <= 1 && !touchesFloor; dy++) {
        for (let dx = -1; dx <= 1 && !touchesFloor; dx++) {
          touchesFloor = tileAt(map, x + dx, y + dy) === 0;
        }
      }
      if (touchesFloor) walls.push({ x, y, tile });
    }
  }
  visibleWalls.set(map, walls);
  return walls;
}

export function drawAutomap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  p: PlayerState,
  hudW: number,
  hudH: number,
): void {
  const { originX, originY, cell } = automapLayout(map, hudW, hudH);
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, hudW, hudH);
  for (const w of wallsToDraw(map)) {
    ctx.fillStyle = ZONE_COLORS[w.tile] ?? (ZONE_COLORS[1] as string);
    ctx.fillRect(originX + w.x * cell, originY + w.y * cell, cell, cell);
  }
  const size = Math.max(cell * 0.9, 6);
  const px = originX + p.x * cell;
  const py = originY + p.y * cell;
  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  ctx.fillStyle = PLAYER;
  ctx.beginPath();
  ctx.moveTo(px + cos * size, py + sin * size);
  ctx.lineTo(px - cos * size * 0.6 - sin * size * 0.6, py - sin * size * 0.6 + cos * size * 0.6);
  ctx.lineTo(px - cos * size * 0.6 + sin * size * 0.6, py - sin * size * 0.6 - cos * size * 0.6);
  ctx.closePath();
  ctx.fill();
}
