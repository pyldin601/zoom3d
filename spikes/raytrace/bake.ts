// The ray-traced bake: every light sample on the floor, ceiling and walls shoots shadow rays at the lamps (direct
// light, soft shadows) and then rays into the room (bounce light), and averages what they bring back. Lamps never
// move, so this runs once, a slice per frame, and the room fills in as it goes.
import { CEILING, clearBetween, createHit, FLOOR, trace, WALL } from './trace';
import { FACE_NX, FACE_NY, LAMP_RADIUS, lampOver, type World } from './world';

/** Floor and ceiling light samples per tile side. */
export const FLOOR_SUB = 8;
/** Wall light samples across a face. */
export const WALL_U = 8;
/** Lamp light reaches this far (tiles), fading smoothly to nothing. */
const REACH = 8;
/** Shadow rays across a lamp when its edge is in doubt. */
const SHADOW_RAYS = 8;
/** Bounce rays per sample and pass. */
const BOUNCE_RAYS = 16;
const BOUNCE_PASSES = 3;
const BOUNCE_REACH = 12;
/** Light that no ray brought: none (the owner chose pure rays; rooms without lamps are dark). */
export const FILL = 0;

export interface Lightmaps {
  /** Light samples up a wall face: floor, middle and ceiling with 3. */
  wallV: number;
  floor: Float32Array;
  ceiling: Float32Array;
  wall: Float32Array;
  /** Floor and ceiling light averaged over about a tile: what a rough reflection's wide cone sees. */
  floorSoft: Float32Array;
  ceilingSoft: Float32Array;
}

/** Cells each way the soft floor and ceiling light averages over (twice, so it falls off). */
const SOFT_REACH = 4;

interface Samples {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  /** 0 floor, 1 ceiling, 2 wall, and where in that lightmap (× 3). */
  surface: Uint8Array;
  at: Int32Array;
}

export function createLightmaps(world: World, wallV: number): Lightmaps {
  const cells = world.w * FLOOR_SUB * world.h * FLOOR_SUB * 3;
  return {
    wallV,
    floor: new Float32Array(cells).fill(FILL),
    ceiling: new Float32Array(cells).fill(FILL),
    wall: new Float32Array(world.faces * WALL_U * wallV * 3).fill(FILL),
    floorSoft: new Float32Array(cells).fill(FILL),
    ceilingSoft: new Float32Array(cells).fill(FILL),
  };
}

/** Bakes into `maps` a slice at a time; each yield is the fraction done. */
export function* bake(world: World, maps: Lightmaps): Generator<number, void, void> {
  const samples = listSamples(world, maps.wallV);
  const direct = [new Float32Array(maps.floor.length), new Float32Array(maps.ceiling.length), new Float32Array(maps.wall.length)];
  const shown = [maps.floor, maps.ceiling, maps.wall];
  const total = samples.count * (1 + BOUNCE_PASSES);
  let done = 0;
  for (let i = 0; i < samples.count; i++) {
    const lm = direct[samples.surface[i] ?? 0] as Float32Array;
    const at = samples.at[i] ?? 0;
    directLight(world, samples, i, lm, at);
    (shown[samples.surface[i] ?? 0] as Float32Array).set(lm.subarray(at, at + 3), at);
    if (++done % 512 === 0) {
      yield done / total;
    }
  }
  let source = direct;
  for (let pass = 0; pass < BOUNCE_PASSES; pass++) {
    const bounced = [new Float32Array(maps.floor.length), new Float32Array(maps.ceiling.length), new Float32Array(maps.wall.length)];
    for (let i = 0; i < samples.count; i++) {
      const s = samples.surface[i] ?? 0;
      const at = samples.at[i] ?? 0;
      gatherBounce(world, maps.wallV, samples, i, source, bounced[s] as Float32Array, at);
      const d = direct[s] as Float32Array;
      const b = bounced[s] as Float32Array;
      const out = shown[s] as Float32Array;
      for (let c = 0; c < 3; c++) {
        out[at + c] = FILL + (d[at + c] ?? 0) + (b[at + c] ?? 0);
      }
      if (++done % 512 === 0) {
        yield done / total;
      }
    }
    source = bounced.map((b, s) => {
      const sum = new Float32Array(b.length);
      const d = direct[s] as Float32Array;
      for (let k = 0; k < b.length; k++) {
        sum[k] = (d[k] ?? 0) + (b[k] ?? 0);
      }
      return sum;
    });
    if (pass === BOUNCE_PASSES - 1) {
      smoothFloor(world, bounced[0] as Float32Array);
      smoothFloor(world, bounced[1] as Float32Array);
      for (let s = 0; s < 3; s++) {
        const out = shown[s] as Float32Array;
        const d = direct[s] as Float32Array;
        const b = bounced[s] as Float32Array;
        for (let k = 0; k < out.length; k++) {
          out[k] = FILL + (d[k] ?? 0) + (b[k] ?? 0);
        }
      }
    }
  }
  spreadIntoWalls(world, maps.floor);
  spreadIntoWalls(world, maps.ceiling);
  soften(world, maps.floor, maps.floorSoft);
  soften(world, maps.ceiling, maps.ceilingSoft);
}

/** Box-averages `lm` over SOFT_REACH cells each way, twice (a tent), into `out`. */
function soften(world: World, lm: Float32Array, out: Float32Array): void {
  const stride = world.w * FLOOR_SUB;
  const rows = world.h * FLOOR_SUB;
  const tmp = new Float32Array(lm.length);
  out.set(lm);
  for (let round = 0; round < 2; round++) {
    boxPass(out, tmp, stride, rows, 3, stride * 3);
    boxPass(tmp, out, rows, stride, stride * 3, 3);
  }
}

/** One box average along lines: `count` lines of `len` cells, `step` apart within a line, `lineStep` between lines. */
function boxPass(src: Float32Array, dst: Float32Array, len: number, count: number, step: number, lineStep: number): void {
  for (let line = 0; line < count; line++) {
    const base = line * lineStep;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      let n = 0;
      for (let i = -SOFT_REACH; i < len + SOFT_REACH; i++) {
        const add = i + SOFT_REACH;
        if (add < len) {
          sum += src[base + add * step + c] ?? 0;
          n++;
        }
        const drop = i - SOFT_REACH - 1;
        if (drop >= 0) {
          sum -= src[base + drop * step + c] ?? 0;
          n--;
        }
        if (i >= 0 && i < len) {
          dst[base + i * step + c] = sum / n;
        }
      }
    }
  }
}

function listSamples(world: World, wallV: number): Samples {
  const { w, h } = world;
  const sub = FLOOR_SUB;
  let open = 0;
  for (const s of world.solid) {
    open += s === 0 ? 1 : 0;
  }
  const max = open * sub * sub * 2 + world.faces * WALL_U * wallV;
  const out: Samples = {
    count: 0,
    x: new Float32Array(max),
    y: new Float32Array(max),
    z: new Float32Array(max),
    nx: new Float32Array(max),
    ny: new Float32Array(max),
    nz: new Float32Array(max),
    surface: new Uint8Array(max),
    at: new Int32Array(max),
  };
  const add = (x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: number, at: number) => {
    const i = out.count++;
    out.x[i] = x;
    out.y[i] = y;
    out.z[i] = z;
    out.nx[i] = nx;
    out.ny[i] = ny;
    out.nz[i] = nz;
    out.surface[i] = surface;
    out.at[i] = at;
  };
  const stride = w * sub;
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (world.solid[ty * w + tx] === 0) {
        for (let j = 0; j < sub; j++) {
          for (let i = 0; i < sub; i++) {
            const at = ((ty * sub + j) * stride + tx * sub + i) * 3;
            const x = tx + (i + 0.5) / sub;
            const y = ty + (j + 0.5) / sub;
            add(x, y, 0, 0, 0, 1, 0, at);
            add(x, y, 1, 0, 0, -1, 1, at);
          }
        }
        continue;
      }
      for (let f = 0; f < 4; f++) {
        const face = world.faceIndex[(ty * w + tx) * 4 + f] ?? -1;
        if (face < 0) {
          continue;
        }
        const nx = FACE_NX[f] ?? 0;
        const ny = FACE_NY[f] ?? 0;
        for (let v = 0; v < wallV; v++) {
          for (let u = 0; u < WALL_U; u++) {
            const along = (u + 0.5) / WALL_U;
            // On the face, nudged into the open cell in front so its rays start outside the wall.
            const x = nx === 0 ? tx + along : tx + 0.5 + nx * (0.5 + 1e-3);
            const y = ny === 0 ? ty + along : ty + 0.5 + ny * (0.5 + 1e-3);
            add(x, y, wallHeight(v, wallV), nx, ny, 0, 2, ((face * wallV + v) * WALL_U + u) * 3);
          }
        }
      }
    }
  }
  return out;
}

/** Height of wall sample row v: with 3, the floor, the middle and the ceiling. */
export function wallHeight(v: number, wallV: number): number {
  return wallV <= 1 ? 0.5 : v / (wallV - 1);
}

const DISC_OFFSETS = Float64Array.from({ length: SHADOW_RAYS }, (_, i) => ((i + 0.5) / SHADOW_RAYS) * 2 - 1);
/** A strip across the disc at that offset covers this share of it (the chord's length). */
const DISC_WEIGHTS = (() => {
  const w = DISC_OFFSETS.map((s) => Math.sqrt(1 - s * s));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
})();

function directLight(world: World, s: Samples, i: number, lm: Float32Array, at: number): void {
  const px = s.x[i] ?? 0;
  const py = s.y[i] ?? 0;
  const pz = s.z[i] ?? 0;
  const nx = s.nx[i] ?? 0;
  const ny = s.ny[i] ?? 0;
  const nz = s.nz[i] ?? 0;
  let light = 0;
  for (let l = 0; l < world.lampX.length; l++) {
    const lx = world.lampX[l] ?? 0;
    const ly = world.lampY[l] ?? 0;
    const vx = lx - px;
    const vy = ly - py;
    const vz = 1 - pz;
    const flat = Math.hypot(vx, vy);
    if (flat >= REACH || vz <= 0) {
      continue;
    }
    const d2 = flat * flat + vz * vz;
    const d = Math.sqrt(d2);
    const cosSurface = (nx * vx + ny * vy + nz * vz) / d;
    if (cosSurface <= 0) {
      continue;
    }
    // A disc facing down: its light falls off with distance squared, the surface's slant and its own (cosLamp).
    const cosLamp = vz / d;
    const fade = (1 - (flat / REACH) ** 4) ** 2;
    const seen = flat < 1e-6 ? 1 : seenShare(world, px, py, lx, ly, -vy / flat, vx / flat);
    light += ((cosSurface * cosLamp * LAMP_RADIUS * LAMP_RADIUS) / d2) * fade * seen;
  }
  for (let c = 0; c < 3; c++) {
    lm[at + c] = light * (world.lampRgb[c] ?? 0);
  }
}

/** The share of a lamp a point sees: shadow rays to strips across it, all of them only where its edges disagree. */
function seenShare(world: World, px: number, py: number, lx: number, ly: number, ax: number, ay: number): number {
  const r = LAMP_RADIUS * 0.9;
  const centre = clearBetween(world, px, py, lx, ly);
  const left = clearBetween(world, px, py, lx - ax * r, ly - ay * r);
  const right = clearBetween(world, px, py, lx + ax * r, ly + ay * r);
  if (centre && left && right) {
    return 1;
  }
  if (!centre && !left && !right) {
    return 0;
  }
  let seen = 0;
  for (let k = 0; k < SHADOW_RAYS; k++) {
    const o = (DISC_OFFSETS[k] ?? 0) * LAMP_RADIUS;
    if (clearBetween(world, px, py, lx + ax * o, ly + ay * o)) {
      seen += DISC_WEIGHTS[k] ?? 0;
    }
  }
  return seen;
}

const bounceHit = createHit();
let seed = 12345;
function random(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

/** Cosine-weighted rays over the sample's hemisphere; each brings back the light its hit throws back. */
function gatherBounce(
  world: World,
  wallV: number,
  s: Samples,
  i: number,
  source: Float32Array[],
  out: Float32Array,
  at: number
): void {
  const px = s.x[i] ?? 0;
  const py = s.y[i] ?? 0;
  const pz = Math.min(0.999, Math.max(0.001, s.z[i] ?? 0));
  const nx = s.nx[i] ?? 0;
  const ny = s.ny[i] ?? 0;
  const nz = s.nz[i] ?? 0;
  // Two directions across the surface: for the floor and ceiling x and y, for a wall along it and up.
  const ax = nz !== 0 ? 1 : -ny;
  const ay = nz !== 0 ? 0 : nx;
  const bx = 0;
  const by = nz !== 0 ? 1 : 0;
  const bz = nz !== 0 ? 0 : 1;
  const side = Math.sqrt(BOUNCE_RAYS);
  const turn = random();
  let r = 0;
  let g = 0;
  let b = 0;
  for (let k = 0; k < BOUNCE_RAYS; k++) {
    const u1 = ((k % side) + random()) / side;
    const u2 = (Math.floor(k / side) + random()) / side;
    const rad = Math.sqrt(u1);
    const phi = 2 * Math.PI * (u2 + turn);
    const a = rad * Math.cos(phi);
    const c = rad * Math.sin(phi);
    const up = Math.sqrt(1 - u1);
    const dx = ax * a + bx * c + nx * up;
    const dy = ay * a + by * c + ny * up;
    const dz = bz * c + nz * up;
    trace(world, px, py, pz, dx, dy, dz, BOUNCE_REACH, bounceHit);
    let lm: Float32Array;
    let idx: number;
    let albedo: Float32Array;
    if (bounceHit.kind === WALL) {
      if (bounceHit.faceIndex < 0) {
        continue;
      }
      lm = source[2] as Float32Array;
      const u = Math.min(WALL_U - 1, Math.floor(bounceHit.u * WALL_U));
      const v = Math.min(wallV - 1, Math.round(bounceHit.z * (wallV - 1)));
      idx = ((bounceHit.faceIndex * wallV + v) * WALL_U + u) * 3;
      albedo = world.meanAlbedo[bounceHit.tile] as Float32Array;
    } else if (bounceHit.kind === FLOOR || bounceHit.kind === CEILING) {
      if (bounceHit.kind === CEILING && lampOver(world, bounceHit.x, bounceHit.y) >= 0) {
        // The lamp's own light is the direct part, already counted.
        continue;
      }
      lm = source[bounceHit.kind === FLOOR ? 0 : 1] as Float32Array;
      const stride = world.w * FLOOR_SUB;
      idx = (Math.floor(bounceHit.y * FLOOR_SUB) * stride + Math.floor(bounceHit.x * FLOOR_SUB)) * 3;
      albedo = bounceHit.kind === FLOOR ? world.floorAlbedo : world.ceilingAlbedo;
    } else {
      continue;
    }
    r += (lm[idx] ?? 0) * (albedo[0] ?? 0);
    g += (lm[idx + 1] ?? 0) * (albedo[1] ?? 0);
    b += (lm[idx + 2] ?? 0) * (albedo[2] ?? 0);
  }
  out[at] = r / BOUNCE_RAYS;
  out[at + 1] = g / BOUNCE_RAYS;
  out[at + 2] = b / BOUNCE_RAYS;
}

/** Bounce light is smooth; a 3×3 average over open samples takes out the noise of 16 rays. */
function smoothFloor(world: World, lm: Float32Array): void {
  const stride = world.w * FLOOR_SUB;
  const rows = world.h * FLOOR_SUB;
  const copy = lm.slice();
  const open = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < stride && y < rows && world.solid[Math.floor(y / FLOOR_SUB) * world.w + Math.floor(x / FLOOR_SUB)] === 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < stride; x++) {
      if (!open(x, y)) {
        continue;
      }
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          if (open(x + i, y + j)) {
            const k = ((y + j) * stride + x + i) * 3;
            r += copy[k] ?? 0;
            g += copy[k + 1] ?? 0;
            b += copy[k + 2] ?? 0;
            n++;
          }
        }
      }
      const k = (y * stride + x) * 3;
      lm[k] = r / n;
      lm[k + 1] = g / n;
      lm[k + 2] = b / n;
    }
  }
}

/** Samples inside wall cells take their open neighbours' light, so blending near a wall doesn't pull in black. */
function spreadIntoWalls(world: World, lm: Float32Array): void {
  const stride = world.w * FLOOR_SUB;
  const rows = world.h * FLOOR_SUB;
  const filled = new Uint8Array(stride * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < stride; x++) {
      filled[y * stride + x] = world.solid[Math.floor(y / FLOOR_SUB) * world.w + Math.floor(x / FLOOR_SUB)] === 0 ? 1 : 0;
    }
  }
  for (let round = 0; round < 2; round++) {
    const was = filled.slice();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < stride; x++) {
        if (was[y * stride + x]) {
          continue;
        }
        let n = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const xx = x + i;
            const yy = y + j;
            if (xx >= 0 && yy >= 0 && xx < stride && yy < rows && was[yy * stride + xx]) {
              const k = (yy * stride + xx) * 3;
              r += lm[k] ?? 0;
              g += lm[k + 1] ?? 0;
              b += lm[k + 2] ?? 0;
              n++;
            }
          }
        }
        if (n > 0) {
          const k = (y * stride + x) * 3;
          lm[k] = r / n;
          lm[k + 1] = g / n;
          lm[k + 2] = b / n;
          filled[y * stride + x] = 1;
        }
      }
    }
  }
}
