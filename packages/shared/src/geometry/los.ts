// Grid line of sight for audio occlusion: is there a wall cell strictly between two points?
import { type GameMap, tileAt } from '../map/map';

export function hasLineOfSight(map: GameMap, ax: number, ay: number, bx: number, by: number): boolean {
  let x = Math.floor(ax);
  let y = Math.floor(ay);
  const endX = Math.floor(bx);
  const endY = Math.floor(by);
  const dx = bx - ax;
  const dy = by - ay;
  const stepX = dx < 0 ? -1 : 1;
  const stepY = dy < 0 ? -1 : 1;
  const deltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const deltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  // Parametric distance (0..1 along a→b) to the next vertical / horizontal grid line.
  let sideX = dx < 0 ? (ax - x) * deltaX : (x + 1 - ax) * deltaX;
  let sideY = dy < 0 ? (ay - y) * deltaY : (y + 1 - ay) * deltaY;
  const maxSteps = Math.abs(endX - x) + Math.abs(endY - y);

  for (let i = 0; i < maxSteps; i++) {
    if (sideX < sideY) {
      sideX += deltaX;
      x += stepX;
    } else {
      sideY += deltaY;
      y += stepY;
    }
    if (x === endX && y === endY) return true;
    if (tileAt(map, x, y) !== 0) return false;
  }
  return true;
}
