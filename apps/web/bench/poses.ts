// Seeded camera poses and avatar glows over LEVEL1, shared by the renderer benches (bench:walls, bench:traced), so each
// draws the same views.
import { type GameMap, tileAt } from '@zoom3d/shared';
import type { Glow } from '../src/renderer/glow';

/** Glowing avatars in a crowd. */
export const CROWD = 100;

interface Point {
  x: number;
  y: number;
}

export interface Pose {
  x: number;
  y: number;
  angle: number;
  glows: Glow[];
}

/** Up to 8 seeded poses within 2.5 tiles of each lamp, facing anywhere, with glowing avatars around them. */
export function posesNearLamps(map: GameMap, lights: readonly Point[]): Pose[] {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const open = (x: number, y: number) => tileAt(map, Math.floor(x), Math.floor(y)) === 0;
  const out: Pose[] = [];
  for (const l of lights) {
    for (let k = 0; k < 8; k++) {
      const x = l.x + (rand() - 0.5) * 5;
      const y = l.y + (rand() - 0.5) * 5;
      if (!open(x, y)) {
        continue;
      }
      const glows: Glow[] = [];
      for (let j = 0; j < 7; j++) {
        const gx = x + (rand() - 0.5) * 4;
        const gy = y + (rand() - 0.5) * 4;
        if (open(gx, gy)) {
          glows.push({ x: gx, y: gy, r: rand() * 0.6, g: rand() * 0.6, b: rand() * 0.6 });
        }
      }
      glows.push({ x, y, r: 0.3, g: 0.25, b: 0.2 });
      out.push({ x, y, angle: rand() * Math.PI * 2, glows });
    }
  }
  return out;
}

/** CROWD seeded glows anywhere open on the map. */
export function crowdGlows(map: GameMap): Glow[] {
  let seed = 3;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: Glow[] = [];
  while (out.length < CROWD) {
    const x = rand() * map.width;
    const y = rand() * map.height;
    if (tileAt(map, Math.floor(x), Math.floor(y)) === 0) {
      out.push({ x, y, r: rand() * 0.6, g: rand() * 0.6, b: rand() * 0.6 });
    }
  }
  return out;
}
