// Top-down automap drawn on the HUD canvas.
import { type GameMap, type PlayerState, tileAt } from '@zoom3d/shared';
import { inLabelRange } from './labels';

/** The map fills at most this fraction of the HUD's width and height. */
const FILL = 0.9;
const ZONE_COLORS = ['', '#8c8e8c', '#7a5530', '#1a2cc0'];
const BACKDROP = 'rgba(0, 0, 0, 0.75)';
const YOUR_ARROW_COLOUR = '#ffd400';
const NAME_COLOUR = '#fff';
/** Sizes in map cells, each with a floor in HUD pixels so a large map stays readable. */
const DOT_RADIUS = 0.45;
const MIN_DOT_RADIUS_PX = 4;
const NAME_SIZE = 0.9;
const MIN_NAME_SIZE_PX = 10;
const NAME_GAP_PX = 2;
const ARROW_LENGTH = 0.9;
const MIN_ARROW_LENGTH_PX = 6;
/** The arrow's two back corners, each this fraction of its length behind its tip and to one side. */
const ARROW_BACK = 0.6;

export interface AutomapLayout {
  originX: number;
  originY: number;
  cell: number;
}

export interface AutomapPeer {
  x: number;
  y: number;
  color: string;
  name: string;
}

export function automapLayout(map: GameMap, hudW: number, hudH: number): AutomapLayout {
  const cell = Math.max(1, Math.floor(Math.min((hudW * FILL) / map.width, (hudH * FILL) / map.height)));
  return {
    originX: Math.floor((hudW - map.width * cell) / 2),
    originY: Math.floor((hudH - map.height * cell) / 2),
    cell,
  };
}

/** The map over a dimmed HUD canvas: its walls, everyone's dot (named when near) and the local player's arrow. */
export function drawAutomap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  p: PlayerState,
  others: readonly AutomapPeer[] = []
): void {
  const { width, height } = ctx.canvas;
  const layout = automapLayout(map, width, height);
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, width, height);
  drawWalls(ctx, map, layout);
  drawPeople(ctx, p, others, layout);
  drawPlayerArrow(ctx, p, layout);
}

function drawWalls(ctx: CanvasRenderingContext2D, map: GameMap, { originX, originY, cell }: AutomapLayout): void {
  for (const w of wallsTouchingFloor(map)) {
    ctx.fillStyle = ZONE_COLORS[w.tile] ?? (ZONE_COLORS[1] as string);
    ctx.fillRect(originX + w.x * cell, originY + w.y * cell, cell, cell);
  }
}

const wallsTouchingFloorOf = new WeakMap<GameMap, { x: number; y: number; tile: number }[]>();

/** Walls that touch floor (8-neighbourhood); the rest of the solid mass is never seen. Worked out once per map. */
function wallsTouchingFloor(map: GameMap) {
  let walls = wallsTouchingFloorOf.get(map);
  if (walls) {
    return walls;
  }
  walls = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = tileAt(map, x, y);
      if (tile !== 0 && touchesFloor(map, x, y)) {
        walls.push({ x, y, tile });
      }
    }
  }
  wallsTouchingFloorOf.set(map, walls);
  return walls;
}

function touchesFloor(map: GameMap, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (tileAt(map, x + dx, y + dy) === 0) {
        return true;
      }
    }
  }
  return false;
}

/** Everyone's dot in their colour, with their name over it while they're within LABEL_TILES of the local player. */
function drawPeople(
  ctx: CanvasRenderingContext2D,
  p: PlayerState,
  others: readonly AutomapPeer[],
  { originX, originY, cell }: AutomapLayout
): void {
  const dot = Math.max(cell * DOT_RADIUS, MIN_DOT_RADIUS_PX);
  ctx.font = `${Math.max(MIN_NAME_SIZE_PX, Math.round(cell * NAME_SIZE))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const o of others) {
    const ox = originX + o.x * cell;
    const oy = originY + o.y * cell;
    ctx.fillStyle = o.color;
    ctx.beginPath();
    ctx.arc(ox, oy, dot, 0, Math.PI * 2);
    ctx.fill();
    if (inLabelRange(p, o.x, o.y)) {
      ctx.fillStyle = NAME_COLOUR;
      ctx.fillText(o.name, ox, oy - dot - NAME_GAP_PX);
    }
  }
}

/** A triangle where the local player stands, pointing the way they face. */
function drawPlayerArrow(
  ctx: CanvasRenderingContext2D,
  p: PlayerState,
  { originX, originY, cell }: AutomapLayout
): void {
  const size = Math.max(cell * ARROW_LENGTH, MIN_ARROW_LENGTH_PX);
  const px = originX + p.x * cell;
  const py = originY + p.y * cell;
  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  ctx.fillStyle = YOUR_ARROW_COLOUR;
  ctx.beginPath();
  ctx.moveTo(px + cos * size, py + sin * size);
  ctx.lineTo(
    px - cos * size * ARROW_BACK - sin * size * ARROW_BACK,
    py - sin * size * ARROW_BACK + cos * size * ARROW_BACK
  );
  ctx.lineTo(
    px - cos * size * ARROW_BACK + sin * size * ARROW_BACK,
    py - sin * size * ARROW_BACK - cos * size * ARROW_BACK
  );
  ctx.closePath();
  ctx.fill();
}
