// SPIKE: static point lights baked into lightmaps once per map, so a frame pays one table lookup per floor or
// ceiling pixel and one lookup plus a multiply per wall pixel. Shadows are hard and grid-exact: each sample asks
// whether its light can see it (2D line of sight), so wall corners throw shadows along walls and floors.
import { type GameMap, hasLineOfSight, tileAt } from '@zoom3d/shared';
import { rgb } from './framebuffer';

export interface Light {
  x: number;
  y: number;
  /** Height above the floor (0..1, the ceiling is 1). */
  z: number;
  /** Reach in tiles: nothing past it is lit. */
  radius: number;
  /** Linear colour × intensity per channel (1 = full brightness at the lamp). */
  r: number;
  g: number;
  b: number;
}

/** Wall face samples: U across the face, V down it (one per 8 texel rows of a 64 texture). */
export const WALL_U = 16;
export const WALL_V = 8;
/** Floor and ceiling samples per tile edge. */
export const FLOOR_SUB = 8;
/** Light multipliers are packed 0xBBGGRR with 128 = 1.0, so a lamp can overbright up to 2×. */
const ONE = 128;
/** Ceiling cells within this distance (tiles) of a lamp show the lamp itself. */
const FIXTURE_RADIUS = 0.18;
const FIXTURE = rgb(255, 236, 190);

export interface Lighting {
  /** Per wall cell × face (0 W, 1 E, 2 N, 3 S): offset into `wall`, or −1 when the face touches no floor. */
  faceOffset: Int32Array;
  /** Packed multipliers, [face][u][v]. */
  wall: Uint32Array;
  /** Final floor / ceiling colours, (map.width·FLOOR_SUB) × (map.height·FLOOR_SUB). */
  floor: Uint32Array;
  ceiling: Uint32Array;
  stride: number;
  rows: number;
}

const FACES: readonly { dx: number; dy: number }[] = [
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
];

function pack(r: number, g: number, b: number): number {
  const q = (v: number) => Math.min(255, Math.round(v * ONE));
  return (q(b) << 16) | (q(g) << 8) | q(r);
}

function tint(colour: number, r: number, g: number, b: number): number {
  const c = (v: number, k: number) => Math.min(255, Math.round(v * k));
  return rgb(c(colour & 0xff, r), c((colour >>> 8) & 0xff, g), c((colour >>> 16) & 0xff, b));
}

function falloff(dist: number, radius: number): number {
  const t = dist / radius;
  if (t >= 1) {
    return 0;
  }
  const k = 1 - t * t;
  return k * k;
}

export function bakeLighting(
  map: GameMap,
  lights: readonly Light[],
  ambient: number,
  floorColour: number,
  ceilingColour: number
): Lighting {
  const { width, height } = map;
  const faceOffset = new Int32Array(width * height * 4).fill(-1);
  let faces = 0;
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      if (tileAt(map, cx, cy) === 0) {
        continue;
      }
      for (let f = 0; f < 4; f++) {
        const n = FACES[f] as { dx: number; dy: number };
        if (tileAt(map, cx + n.dx, cy + n.dy) === 0) {
          faceOffset[(cy * width + cx) * 4 + f] = faces++ * WALL_U * WALL_V;
        }
      }
    }
  }

  const wall = new Uint32Array(faces * WALL_U * WALL_V);
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      for (let f = 0; f < 4; f++) {
        const base = faceOffset[(cy * width + cx) * 4 + f] as number;
        if (base < 0) {
          continue;
        }
        const n = FACES[f] as { dx: number; dy: number };
        // The old renderer's fake sun: north/south faces at 70%. It now only shades the ambient part.
        const amb = ambient * (n.dy !== 0 ? 0.7 : 1);
        for (let u = 0; u < WALL_U; u++) {
          const along = (u + 0.5) / WALL_U;
          const px = n.dx === 0 ? cx + along : n.dx < 0 ? cx : cx + 1;
          const py = n.dy === 0 ? cy + along : n.dy < 0 ? cy : cy + 1;
          const r = new Float64Array(WALL_V).fill(amb);
          const g = new Float64Array(WALL_V).fill(amb);
          const b = new Float64Array(WALL_V).fill(amb);
          for (const l of lights) {
            const dx = l.x - px;
            const dy = l.y - py;
            const facing = dx * n.dx + dy * n.dy;
            if (facing <= 0 || Math.hypot(dx, dy) >= l.radius) {
              continue;
            }
            if (!hasLineOfSight(map, px + n.dx * 1e-3, py + n.dy * 1e-3, l.x, l.y)) {
              continue;
            }
            for (let v = 0; v < WALL_V; v++) {
              const dz = l.z - (1 - (v + 0.5) / WALL_V);
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
              const k = falloff(dist, l.radius) * (facing / dist);
              r[v] = (r[v] as number) + l.r * k;
              g[v] = (g[v] as number) + l.g * k;
              b[v] = (b[v] as number) + l.b * k;
            }
          }
          for (let v = 0; v < WALL_V; v++) {
            wall[base + u * WALL_V + v] = pack(r[v] as number, g[v] as number, b[v] as number);
          }
        }
      }
    }
  }

  const stride = width * FLOOR_SUB;
  const rows = height * FLOOR_SUB;
  const floor = new Uint32Array(stride * rows).fill(tint(floorColour, ambient, ambient, ambient));
  const ceiling = new Uint32Array(stride * rows).fill(tint(ceilingColour, ambient, ambient, ambient));
  for (let sy = 0; sy < rows; sy++) {
    for (let sx = 0; sx < stride; sx++) {
      const px = (sx + 0.5) / FLOOR_SUB;
      const py = (sy + 0.5) / FLOOR_SUB;
      if (tileAt(map, Math.floor(px), Math.floor(py)) !== 0) {
        continue;
      }
      let fr = ambient;
      let fg = ambient;
      let fb = ambient;
      let cr = ambient;
      let cg = ambient;
      let cb = ambient;
      let fixture = false;
      for (const l of lights) {
        const dx = l.x - px;
        const dy = l.y - py;
        const flat = Math.hypot(dx, dy);
        if (flat >= l.radius || !hasLineOfSight(map, px, py, l.x, l.y)) {
          continue;
        }
        if (flat < FIXTURE_RADIUS) {
          fixture = true;
        }
        const df = Math.sqrt(flat * flat + l.z * l.z);
        const kf = falloff(df, l.radius) * (l.z / df);
        fr += l.r * kf;
        fg += l.g * kf;
        fb += l.b * kf;
        const up = 1 - l.z;
        const dc = Math.sqrt(flat * flat + up * up);
        // The ceiling sees the lamp almost edge-on; lift it a little so the pool still reads.
        const kc = falloff(dc, l.radius) * Math.max(0.35, up / dc);
        cr += l.r * kc;
        cg += l.g * kc;
        cb += l.b * kc;
      }
      floor[sy * stride + sx] = tint(floorColour, fr, fg, fb);
      ceiling[sy * stride + sx] = fixture ? FIXTURE : tint(ceilingColour, cr, cg, cb);
    }
  }
  return { faceOffset, wall, floor, ceiling, stride, rows };
}

export const LAMP = { r: 1.25, g: 1.05, b: 0.75 };

/**
 * Lamps along every corridor (a floor run at most 3 tiles across and at least 4 long), on its centre line, at
 * least `spacing` tiles apart.
 */
export function corridorLights(map: GameMap, spacing = 5, radius = 4.5): Light[] {
  const { width, height } = map;
  const floor = (x: number, y: number) => tileAt(map, x, y) === 0;
  const lights: Light[] = [];
  const far = (x: number, y: number) => lights.every((l) => Math.hypot(l.x - x, l.y - y) >= spacing);
  const run = (x: number, y: number, dx: number, dy: number) => {
    let a = 0;
    while (floor(x - dx * (a + 1), y - dy * (a + 1))) {
      a++;
    }
    let b = 0;
    while (floor(x + dx * (b + 1), y + dy * (b + 1))) {
      b++;
    }
    return { a, b, len: a + b + 1 };
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!floor(x, y)) {
        continue;
      }
      const h = run(x, y, 1, 0);
      const v = run(x, y, 0, 1);
      let lx: number;
      let ly: number;
      if (h.len <= 3 && v.len >= 4) {
        lx = x - h.a + h.len / 2;
        ly = y + 0.5;
      } else if (v.len <= 3 && h.len >= 4) {
        lx = x + 0.5;
        ly = y - v.a + v.len / 2;
      } else {
        continue;
      }
      if (far(lx, ly)) {
        lights.push({ x: lx, y: ly, z: 0.85, radius, ...LAMP });
      }
    }
  }
  return lights;
}
