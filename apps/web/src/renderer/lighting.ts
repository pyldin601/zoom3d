// SPIKE: static point lights baked into lightmaps once per map, so a frame pays one table lookup per floor or
// ceiling pixel and one lookup plus a multiply per wall pixel. Shadows are hard and grid-exact: each sample asks
// whether its light can see it (2D line of sight), so wall corners throw shadows along walls and floors.
import { type GameMap, hasLineOfSight, tileAt } from '@zoom3d/shared';
import { rgb } from './framebuffer';
import { RELIEF_LEVELS } from './textures';

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
/** The eye's height above the floor: walls are drawn centred on the horizon. */
const EYE_Z = 0.5;
/**
 * Walls glint only this many tiles from the eye, fading to nothing here: a streak along the wall you're by stays near
 * you, and a far wall that happens to lie in line with the eye (close to its plane) doesn't flash.
 */
export const GLINT_RANGE = 4;
/** A wall glints only while the eye is this close to it (tiles off its face), fading to nothing at this distance. */
export const GLINT_NEAR = 2;
/** Lamps a wall sample column can glint with (nearest first), so a wall can mirror the lamp you look towards. */
export const GLINT_LAMPS = 3;
/** A lamp's reflection carries this many times its light's reach: you see a lamp further off than it lights. */
const GLINT_REACH = 2;
/** A lamp's streak along a wall carries this many times its light's reach. */
const STREAK_REACH = 1.5;
/** A full streak adds this much of the lamp's colour (×255), like GLINT_STRENGTH. */
export const STREAK_STRENGTH = 0.385;
/** Half the streak's height on the wall (the wall is 1 high): it fades from its centre line to nothing at this. */
export const STREAK_HALF_HEIGHT = 0.25;
/** A full glint adds this much of the lamp's colour (×255) on top of the lit texel. */
export const GLINT_STRENGTH = 0.35;

export interface Lighting {
  map: GameMap;
  lights: readonly Light[];
  ambient: number;
  /** Per wall cell × face (0 W, 1 E, 2 N, 3 S): offset into `wall`, or −1 when the face touches no floor. */
  faceOffset: Int32Array;
  /** Packed multipliers, [face][u][v][relief level]: ambient + lamps × (1 + RELIEF_LEVELS[level]). */
  wall: Uint32Array;
  /**
   * Per face sample column ([face][u][k], so (faceOffset / WALL_V + u) · GLINT_LAMPS + k): the lamps in sight and in
   * reflection reach, nearest first, −1 past the last.
   */
  wallLamp: Int16Array;
  /** Final floor / ceiling colours, (map.width·FLOOR_SUB) × (map.height·FLOOR_SUB). */
  floor: Uint32Array;
  ceiling: Uint32Array;
  stride: number;
  rows: number;
}

export const FACES: readonly { dx: number; dy: number }[] = [
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
];

function pack(r: number, g: number, b: number): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * ONE)));
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

  const levels = RELIEF_LEVELS.length;
  const wall = new Uint32Array(faces * WALL_U * WALL_V * levels);
  const wallLamp = new Int16Array(faces * WALL_U * GLINT_LAMPS).fill(-1);
  const seen: { i: number; dist: number }[] = [];
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
          const r = new Float64Array(WALL_V);
          const g = new Float64Array(WALL_V);
          const b = new Float64Array(WALL_V);
          seen.length = 0;
          for (let i = 0; i < lights.length; i++) {
            const l = lights[i] as Light;
            const dx = l.x - px;
            const dy = l.y - py;
            const facing = dx * n.dx + dy * n.dy;
            const flat = Math.hypot(dx, dy);
            if (facing <= 0 || flat >= l.radius * GLINT_REACH) {
              continue;
            }
            if (!hasLineOfSight(map, px + n.dx * 1e-3, py + n.dy * 1e-3, l.x, l.y)) {
              continue;
            }
            seen.push({ i, dist: flat });
            if (flat >= l.radius) {
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
          seen.sort((a, b) => a.dist - b.dist);
          for (let k = 0; k < Math.min(seen.length, GLINT_LAMPS); k++) {
            wallLamp[(base / WALL_V + u) * GLINT_LAMPS + k] = (seen[k] as { i: number }).i;
          }
          for (let v = 0; v < WALL_V; v++) {
            const rv = r[v] as number;
            const gv = g[v] as number;
            const bv = b[v] as number;
            for (let k = 0; k < levels; k++) {
              const lift = 1 + (RELIEF_LEVELS[k] as number);
              wall[(base + u * WALL_V + v) * levels + k] = pack(amb + rv * lift, amb + gv * lift, amb + bv * lift);
            }
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
  return { map, lights, ambient, faceOffset, wall, wallLamp, floor, ceiling, stride, rows };
}

/**
 * How brightly lamp `l` glints at (px, py, pz) on a wall facing (nx, ny), seen from the eye at (ex, ey): Phong, cos³²
 * of the angle between the lamp and the eye's ray mirrored off the wall, times the lamp's falloff over GLINT_REACH
 * times its reach (a blurry mirror: looking along a wall, you see a lamp further down it), times a sheen
 * 0..1, before the lamp's colour. It runs per texel row on near walls, so squares only, no roots. Shadows are the
 * caller's (wallLamp).
 */
export function glint(
  l: Light,
  nx: number,
  ny: number,
  px: number,
  py: number,
  pz: number,
  ex: number,
  ey: number
): number {
  const lx = l.x - px;
  const ly = l.y - py;
  const lz = l.z - pz;
  const l2 = lx * lx + ly * ly + lz * lz;
  const reach2 = l.radius * l.radius * GLINT_REACH * GLINT_REACH;
  if (l2 >= reach2 || lx * nx + ly * ny <= 0) {
    return 0;
  }
  // The eye's ray to the point, mirrored off the wall.
  let rx = px - ex;
  let ry = py - ey;
  const rz = pz - EYE_Z;
  const into = rx * nx + ry * ny;
  rx -= 2 * into * nx;
  ry -= 2 * into * ny;
  const dot = rx * lx + ry * ly + rz * lz;
  if (dot <= 0) {
    return 0;
  }
  const r2 = rx * rx + ry * ry + rz * rz;
  let c = (dot * dot) / (l2 * r2);
  c *= c;
  c *= c;
  c *= c;
  c *= c;
  const k = 1 - l2 / reach2;
  return c * k * k;
}

/**
 * The streak lamp `l` leaves along a wall seen at a shallow angle, a rough wall's blurry reflection smeared towards
 * the light: on the column at (px, py) of a wall facing (nx, ny), seen from (ex, ey), `out[0]` gets its strength 0..1
 * and `out[1]` the height it runs at, where the wall bounces the eye's ray to the lamp. The strength is a broad lobe
 * between the eye's ray mirrored off the wall and the lamp, seen from above (cos²), times how flat the eye's ray meets
 * the wall (sin⁸), times the lamp's falloff over STREAK_REACH times its reach. So it grows from the mirror point
 * towards the lamp and fades right beside it. Once per wall column, so roots are fine.
 */
export function streak(
  l: Light,
  nx: number,
  ny: number,
  px: number,
  py: number,
  ex: number,
  ey: number,
  out: Float64Array
): void {
  out[0] = 0;
  out[1] = EYE_Z;
  const lx = l.x - px;
  const ly = l.y - py;
  const l2 = lx * lx + ly * ly;
  const reach2 = l.radius * l.radius * STREAK_REACH * STREAK_REACH;
  if (l2 >= reach2 || lx * nx + ly * ny <= 0) {
    return;
  }
  // The eye's ray to the column, mirrored off the wall, seen from above.
  let rx = px - ex;
  let ry = py - ey;
  const into = rx * nx + ry * ny;
  rx -= 2 * into * nx;
  ry -= 2 * into * ny;
  const dot = rx * lx + ry * ly;
  if (dot <= 0) {
    return;
  }
  const r2 = rx * rx + ry * ry;
  const c2 = (dot * dot) / (r2 * l2);
  const sin2 = 1 - (into * into) / r2;
  const sin4 = sin2 * sin2;
  const k = 1 - l2 / reach2;
  out[0] = c2 * sin4 * sin4 * k * k;
  // Where the ray climbs from the eye to the lamp over the two horizontal legs, eye to wall and wall to lamp.
  const eyeLeg = Math.sqrt(r2);
  const lampLeg = Math.sqrt(l2);
  out[1] = (EYE_Z * lampLeg + l.z * eyeLeg) / (eyeLeg + lampLeg);
}

const streakScratch = new Float64Array(2);

/**
 * Of a wall sample column's lamps (`wallLamp` from `slot`), the one that shines brightest on the column at (px, py)
 * facing (nx, ny), seen from (ex, ey): its glint at its mirror height, where the glint peaks, plus its streak. −1 if
 * none shines there.
 */
export function brightestGlint(
  lm: Lighting,
  slot: number,
  nx: number,
  ny: number,
  px: number,
  py: number,
  ex: number,
  ey: number
): number {
  const eye = (ex - px) * nx + (ey - py) * ny;
  let best = -1;
  let bestGlint = 0;
  for (let k = 0; k < GLINT_LAMPS; k++) {
    const i = lm.wallLamp[slot + k] as number;
    const l = lm.lights.at(i);
    if (i < 0 || !l) {
      break;
    }
    const lamp = (l.x - px) * nx + (l.y - py) * ny;
    const z = EYE_Z + ((l.z - EYE_Z) * eye) / (eye + lamp);
    streak(l, nx, ny, px, py, ex, ey, streakScratch);
    const g = glint(l, nx, ny, px, py, z, ex, ey) + (streakScratch[0] as number);
    if (g > bestGlint) {
      bestGlint = g;
      best = i;
    }
  }
  return best;
}

/** A voxel face's direction in model space (+x front, +y the model's right, +z up), as voxels.ts orders them. */
export const DIR_TOP = 0;
export const DIR_FRONT = 1;
export const DIR_BACK = 2;
export const DIR_RIGHT = 3;
export const DIR_LEFT = 4;

/**
 * Light from the lamps (ambient not included) reaching a moving object at (x, y, z) turned to `angle`, per face
 * direction: `out` gets r, g, b for each DIR_* in turn. Only lamps in reach and in sight count, so a few per call.
 */
export function directLight(lm: Lighting, x: number, y: number, z: number, angle: number, out: Float64Array): void {
  out.fill(0);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (const l of lm.lights) {
    const dx = l.x - x;
    const dy = l.y - y;
    const dz = l.z - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const k = falloff(dist, l.radius);
    if (k === 0 || !hasLineOfSight(lm.map, x, y, l.x, l.y)) {
      continue;
    }
    // The lamp's direction in model space: rotate the horizontal part by −angle.
    const fx = (dx * ca + dy * sa) / dist;
    const fy = (-dx * sa + dy * ca) / dist;
    addLight(out, DIR_TOP, l, k * Math.max(0, dz / dist));
    addLight(out, DIR_FRONT, l, k * Math.max(0, fx));
    addLight(out, DIR_BACK, l, k * Math.max(0, -fx));
    addLight(out, DIR_RIGHT, l, k * Math.max(0, fy));
    addLight(out, DIR_LEFT, l, k * Math.max(0, -fy));
  }
}

function addLight(out: Float64Array, dir: number, l: Light, k: number): void {
  out[dir * 3] = (out[dir * 3] as number) + l.r * k;
  out[dir * 3 + 1] = (out[dir * 3 + 1] as number) + l.g * k;
  out[dir * 3 + 2] = (out[dir * 3 + 2] as number) + l.b * k;
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
