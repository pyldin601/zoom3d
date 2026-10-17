// The ray-traced frame. Per screen column one 2D walk finds the wall, as in the current renderer; every pixel is lit
// from the ray-traced bake. Reflections: a ray mirrored off a wall keeps one 2D direction for the whole column (one more
// walk), and one mirrored off the floor keeps the column's own direction (no walk at all), so only heights differ per
// pixel. A rough surface reflects a cone rather than a ray: as wide as its roughness, widening with distance, and
// stretched along the view at grazing angles (why a lamp leaves a streak in a glossy floor). Round things meet the cone
// in closed form, a soft blob; flat things are shaded through prefiltered light and texture, and the edges between them
// blend over the cone's width. Nothing is blurred on screen.
import { castRay, createRayHit, type PlayerState } from '@zoom3d/shared';
import { FILL, FLOOR_SUB, type Lightmaps, WALL_U } from './bake';
import { faceTexelAt, PERSON_RADIUS, type Person } from './people';
import {
  FACE_E,
  FACE_N,
  FACE_NX,
  FACE_NY,
  FACE_S,
  FACE_W,
  LAMP_RADIUS,
  lampOver,
  MATERIALS,
  type Material,
  TEXELS,
  type World,
} from './world';

const EYE = 0.5;
/** Round things (people, lamps) one ray can pass close enough to show, nearest first. */
const MAX_ROUND_PER_RAY = 12;
/** Tiles: a round thing further than this to the side of a ray never shows in its cone. */
const MAX_MARGIN = 2;
/** A face's brightness in reflections: about what its screen colours look like at the default exposure. */
const FACE_GAIN = 0.3;
/** spec for a pixel showing a face: drawn as its camera colours, like a screen, past exposure and toning. */
const SCREEN = -1;
/** Below this cone width (in radii) a reflected face is still sharp enough to show its texture. */
const SHARP = 0.3;
/** A cone's stretch along the view stops growing at this slant (cos of the angle to the surface normal). */
const GRAZING_MIN = 0.1;
/** Even a mirror blends an edge over this much height (tiles): a little anti-aliasing. */
const EDGE_MIN = 0.02;
/** A texture fades to its average colour as the cone outgrows this (tiles, a brick's height). */
const TEXTURE_DETAIL = 0.25;
/** The floor and ceiling's soft light takes over as the cone grows to this (tiles). */
const LIGHT_DETAIL = 1;
/** Tone tables: steps per unit of exposed brightness, up to TONE_RANGE (a lamp is about 120). */
const TONE_STEPS = 64;
const TONE_SIZE = 128 * TONE_STEPS;
const ENCODE_SIZE = 4096;
const FLOOR_MATERIAL = MATERIALS[0] as Material;
const FLOOR_ALPHA = FLOOR_MATERIAL.roughness * FLOOR_MATERIAL.roughness;

export interface Frame {
  width: number;
  height: number;
  fov: number;
  pixels: Uint32Array;
  zbuffer: Float64Array;
}

export interface TraceSettings {
  reflections: boolean;
  /** Reflections are traced at 1/2 or 1/4 of the frame's resolution. */
  reflectionScale: 2 | 4;
  exposure: number;
}

/** Smoothed per-phase frame time, ms. */
export const phaseMs = { walls: 0, floor: 0, reflections: 0, composite: 0 };

// Per frame: the view.
let eyeX = 0;
let eyeY = 0;
let dirX = 1;
let dirY = 0;
let planeX = 0;
let planeY = 1;
let proj = 1;
let half = 1;

// Buffers, refitted when the frame's size changes.
let W = 0;
let H = 0;
let FOV = 0;
/** The reflection buffer: 1/SCALE of the frame each way. */
let SCALE = 2;
let RW = 0;
let RH = 0;
let hdr = new Float32Array(0);
let spec = new Float32Array(0);
/** Per pixel, the tile id whose material reflects there (0 the floor), for the reflection's tint. */
let specTile = new Uint8Array(0);
/** Per tile id, the colour reflections take on: white blended towards the surface's own hue by its tint. */
const tintRgb = new Float32Array(MATERIALS.length * 3);
/** Per pixel showing a face (spec SCREEN), its colour as is. */
let screen = new Uint32Array(0);
/** Per floor pixel, its Fresnel weight: it depends only on where the pixel is on screen. */
let floorFresnel = new Float32Array(0);
let reflected = new Float32Array(0);
/** The reflection buffer blended out to the frame's width, still at its own height. */
let widened = new Float32Array(0);
/** Per frame column and row: the reflection sample left of (above) it and how far towards the next. */
let upX0 = new Int32Array(0);
let upAX = new Float32Array(0);
let upY0 = new Int32Array(0);
let upAY = new Float32Array(0);
let colRdx = new Float64Array(0);
let colRdy = new Float64Array(0);
let colD = new Float64Array(0);
let colStart = new Int32Array(0);
let colEnd = new Int32Array(0);
let colTile = new Uint8Array(0);
let colFace = new Uint8Array(0);
let colFaceIndex = new Int32Array(0);
let colU = new Float64Array(0);
let colRound = new Uint8Array(0);
let colRoundS = new Float64Array(0);
let colRoundO = new Float64Array(0);
let colRoundWho = new Int16Array(0);

const rayHit = createRayHit();
const mirrorHit = createRayHit();
const shade = new Float32Array(3);
/** The column's wall light at each of the face's sample heights, blended across the face once per column. */
let columnLight = new Float32Array(3 * 8);
/** columnLight for every column (the floor reflects each column's wall), and the mirrored wall's for the current one. */
let columnLights = new Float32Array(0);
const mirrorLight = new Float32Array(3 * 8);
const mirrorRoundS = new Float64Array(MAX_ROUND_PER_RAY);
const mirrorRoundO = new Float64Array(MAX_ROUND_PER_RAY);
const mirrorRoundWho = new Int16Array(MAX_ROUND_PER_RAY);
let lightR = 0;
let lightG = 0;
let lightB = 0;

let world: World;
let maps: Lightmaps;
let people: Person[];
/** Round things this frame: people first, then lamps. Centre, height of centre, radius. */
let roundX = new Float64Array(0);
let roundY = new Float64Array(0);
let roundZ = new Float64Array(0);
let roundR = new Float64Array(0);
let rounds = 0;

/**
 * Toning keeps a colour's hue: its brightest channel goes through 1 - e^-x (straight through the darks, easing into
 * white) and the others scale with it, so a warm highlight stays warm instead of every channel clipping to white. Only
 * far past white (a lamp) does it fade towards white, as film and eyes do. TONE_SCALE is (1 - e^-x) / x, TONE_WHITE how
 * far towards white, both by the brightest channel x.
 */
const TONE_SCALE = Float32Array.from({ length: TONE_SIZE }, (_, i) => {
  const x = i / TONE_STEPS;
  return x === 0 ? 1 : (1 - Math.exp(-x)) / x;
});
const TONE_WHITE = Float32Array.from({ length: TONE_SIZE }, (_, i) => {
  const t = Math.min(1, Math.max(0, (i / TONE_STEPS - 3) / 27));
  return 0.75 * t * t * (3 - 2 * t);
});
/** Linear 0..1 to an sRGB byte. */
const ENCODE = Uint8Array.from({ length: ENCODE_SIZE }, (_, i) => {
  const v = i / (ENCODE_SIZE - 1);
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
});

export function renderTraced(
  w: World,
  lm: Lightmaps,
  who: Person[],
  eye: PlayerState,
  frame: Frame,
  settings: TraceSettings
): void {
  world = w;
  maps = lm;
  people = who;
  fit(frame, settings.reflectionScale);
  aim(eye);
  listRoundThings(true);
  const t0 = performance.now();
  for (let col = 0; col < W; col++) {
    drawColumn(col);
    frame.zbuffer[col] = colD[col] ?? 0;
  }
  const t1 = performance.now();
  drawFloorAndCeiling();
  for (let col = 0; col < W; col++) {
    drawRoundThings(col);
  }
  const t2 = performance.now();
  if (settings.reflections) {
    traceReflections();
  }
  const t3 = performance.now();
  composite(frame.pixels, settings);
  const t4 = performance.now();
  phaseMs.walls += (t1 - t0 - phaseMs.walls) * 0.05;
  phaseMs.floor += (t2 - t1 - phaseMs.floor) * 0.05;
  phaseMs.reflections += (t3 - t2 - phaseMs.reflections) * 0.05;
  phaseMs.composite += (t4 - t3 - phaseMs.composite) * 0.05;
}

/** Draws people unlit over a frame another renderer drew, behind its walls: the current renderer's stand-in. */
export function drawPeopleOver(w: World, who: Person[], eye: PlayerState, frame: Frame): void {
  world = w;
  people = who;
  fit(frame, SCALE);
  aim(eye);
  listRoundThings(false);
  for (let col = 0; col < W; col++) {
    const rdx = dirX + planeX * ((2 * (col + 0.5)) / W - 1);
    const rdy = dirY + planeY * ((2 * (col + 0.5)) / W - 1);
    const base = col * MAX_ROUND_PER_RAY;
    const n = roundAlong(eyeX, eyeY, rdx, rdy, frame.zbuffer[col] ?? 0, 0, colRoundS, colRoundO, colRoundWho, base);
    for (let k = n - 1; k >= 0; k--) {
      const s = colRoundS[base + k] ?? 0;
      const across = -(colRoundO[base + k] ?? 0) / PERSON_RADIUS;
      const p = people[colRoundWho[base + k] ?? 0] as Person;
      const reach = (PERSON_RADIUS * proj) / s;
      for (let y = Math.max(0, Math.floor(half - reach)); y < Math.min(H, Math.ceil(half + reach)); y++) {
        const up = ((half - (y + 0.5)) * s) / proj / PERSON_RADIUS;
        if (across * across + up * up < 1) {
          const texel = faceTexelAt(across, up);
          frame.pixels[y * W + col] = texel < 0 ? p.ringSrgb : (p.faceSrgb[texel] ?? 0);
        }
      }
    }
  }
}

function fit(frame: Frame, scale: number): void {
  if (frame.width === W && frame.height === H && frame.fov === FOV && scale === SCALE) {
    return;
  }
  W = frame.width;
  H = frame.height;
  FOV = frame.fov;
  SCALE = scale;
  RW = Math.floor(W / SCALE);
  RH = Math.floor(H / SCALE);
  hdr = new Float32Array(W * H * 3);
  spec = new Float32Array(W * H);
  specTile = new Uint8Array(W * H);
  screen = new Uint32Array(W * H);
  reflected = new Float32Array(RW * RH * 3);
  widened = new Float32Array(W * RH * 3);
  [upX0, upAX] = upsampling(W, RW);
  [upY0, upAY] = upsampling(H, RH);
  colRdx = new Float64Array(W);
  colRdy = new Float64Array(W);
  colD = new Float64Array(W);
  colStart = new Int32Array(W);
  colEnd = new Int32Array(W);
  colTile = new Uint8Array(W);
  colFace = new Uint8Array(W);
  colFaceIndex = new Int32Array(W);
  colU = new Float64Array(W);
  colRound = new Uint8Array(W);
  colRoundS = new Float64Array(W * MAX_ROUND_PER_RAY);
  colRoundO = new Float64Array(W * MAX_ROUND_PER_RAY);
  colRoundWho = new Int16Array(W * MAX_ROUND_PER_RAY);
  columnLights = new Float32Array(W * 3 * 8);
  // The floor's slant to each pixel's ray doesn't depend on where the eye stands or looks.
  floorFresnel = new Float32Array(W * H);
  const planeLen = Math.tan(FOV / 2);
  const p = W / 2 / planeLen;
  for (let y = 0; y < H; y++) {
    const slope = (y + 0.5 - H / 2) / p;
    if (slope <= 0) {
      continue;
    }
    for (let x = 0; x < W; x++) {
      const camX = ((2 * (x + 0.5)) / W - 1) * planeLen;
      floorFresnel[y * W + x] = fresnel(slope / Math.sqrt(1 + camX * camX + slope * slope), FLOOR_MATERIAL);
    }
  }
}

/** For each of `size` frame pixels, the reflection sample before its centre and how far on towards the next one. */
function upsampling(size: number, samples: number): [Int32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const first = new Int32Array(size);
  const along = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const at = Math.min(samples - 1, Math.max(0, (i + 0.5) / SCALE - 0.5));
    const i0 = Math.min(samples - 2, Math.floor(at));
    first[i] = Math.max(0, i0);
    along[i] = samples < 2 ? 0 : at - Math.max(0, i0);
  }
  return [first, along];
}

function aim(eye: PlayerState): void {
  const planeLen = Math.tan(FOV / 2);
  eyeX = eye.x;
  eyeY = eye.y;
  dirX = Math.cos(eye.angle);
  dirY = Math.sin(eye.angle);
  planeX = -dirY * planeLen;
  planeY = dirX * planeLen;
  proj = W / 2 / planeLen;
  half = H / 2;
}

function listRoundThings(withLamps: boolean): void {
  const lamps = withLamps ? world.lampX.length : 0;
  const n = people.length + lamps;
  if (roundX.length < n) {
    roundX = new Float64Array(n);
    roundY = new Float64Array(n);
    roundZ = new Float64Array(n);
    roundR = new Float64Array(n);
  }
  rounds = n;
  for (let i = 0; i < people.length; i++) {
    const p = people[i] as Person;
    roundX[i] = p.x;
    roundY[i] = p.y;
    roundZ[i] = EYE;
    roundR[i] = PERSON_RADIUS;
  }
  for (let l = 0; l < lamps; l++) {
    const i = people.length + l;
    roundX[i] = world.lampX[l] ?? 0;
    roundY[i] = world.lampY[l] ?? 0;
    // Lamps are discs in the ceiling: they're listed along rays for reflections, and drawn with the ceiling.
    roundZ[i] = 1;
    roundR[i] = LAMP_RADIUS;
  }
}

// The primary pass: what each pixel sees, lit from the bake, and how strongly it reflects (spec, the Fresnel weight).

function drawColumn(col: number): void {
  const cameraX = (2 * (col + 0.5)) / W - 1;
  const rdx = dirX + planeX * cameraX;
  const rdy = dirY + planeY * cameraX;
  castRay(world.map, eyeX, eyeY, rdx, rdy, rayHit);
  const d = rayHit.distance;
  const face = rayHit.side === 0 ? (rdx > 0 ? FACE_W : FACE_E) : rdy > 0 ? FACE_N : FACE_S;
  const faceIndex = world.faceIndex[(rayHit.mapY * world.w + rayHit.mapX) * 4 + face] ?? -1;
  const tile = rayHit.tile;
  const u = rayHit.wallX;
  const texX = Math.min(TEXELS - 1, Math.floor(u * TEXELS));
  const lineH = proj / d;
  const start = Math.max(0, Math.floor(half - lineH / 2));
  const end = Math.max(start, Math.min(H, Math.floor(half + lineH / 2)));
  const flat2 = rdx * rdx + rdy * rdy;
  colRdx[col] = rdx;
  colRdy[col] = rdy;
  colD[col] = d;
  colStart[col] = start;
  colEnd[col] = end;
  colTile[col] = tile;
  colFace[col] = face;
  colFaceIndex[col] = faceIndex;
  colU[col] = u;
  // The column's list also serves the floor's reflections, so it keeps what passes within the floor's cone.
  const floorSpread = FLOOR_ALPHA * Math.sqrt(flat2);
  const base = col * MAX_ROUND_PER_RAY;
  colRound[col] = roundAlong(eyeX, eyeY, rdx, rdy, d, floorSpread, colRoundS, colRoundO, colRoundWho, base);

  const material = (MATERIALS[tile] ?? MATERIALS[1]) as Material;
  const gloss = world.gloss[tile];
  const albedo = world.albedo[tile] as Float32Array;
  const facing = Math.abs((FACE_NX[face] ?? 0) * rdx + (FACE_NY[face] ?? 0) * rdy);
  const heights = blendColumnLight(faceIndex, u, columnLight);
  columnLights.set(columnLight.subarray(0, heights * 3), col * 3 * 8);
  for (let y = start; y < end; y++) {
    const k = (half - (y + 0.5)) / proj;
    const z = clamp01(EYE + k * d);
    const texY = Math.min(TEXELS - 1, Math.floor((1 - z) * TEXELS));
    const fz = z * (heights - 1);
    const j = fz >= heights - 1 ? heights - 2 : fz | 0;
    const az = fz - j;
    const l = j * 3;
    const a = (texY * TEXELS + texX) * 3;
    const i = y * W + col;
    hdr[i * 3] = (albedo[a] ?? 0) * ((columnLight[l] ?? 0) + ((columnLight[l + 3] ?? 0) - (columnLight[l] ?? 0)) * az);
    hdr[i * 3 + 1] =
      (albedo[a + 1] ?? 0) * ((columnLight[l + 1] ?? 0) + ((columnLight[l + 4] ?? 0) - (columnLight[l + 1] ?? 0)) * az);
    hdr[i * 3 + 2] =
      (albedo[a + 2] ?? 0) * ((columnLight[l + 2] ?? 0) + ((columnLight[l + 5] ?? 0) - (columnLight[l + 2] ?? 0)) * az);
    const shiny = gloss ? (gloss[texY * TEXELS + texX] ?? 0) : 0;
    spec[i] = shiny ? fresnel(facing / Math.sqrt(flat2 + k * k), material) : 0;
    specTile[i] = tile;
  }
}

/** Fills `out` with the face's light at u, at each sample height; returns how many heights. */
function blendColumnLight(faceIndex: number, u: number, out: Float32Array): number {
  const rows = maps.wallV;
  if (faceIndex < 0) {
    out.fill(FILL);
    return rows;
  }
  const fu = Math.min(WALL_U - 1, Math.max(0, u * WALL_U - 0.5));
  const i0 = Math.min(WALL_U - 2, Math.floor(fu));
  const au = fu - i0;
  const lm = maps.wall;
  for (let j = 0; j < rows; j++) {
    const a = ((faceIndex * rows + j) * WALL_U + i0) * 3;
    for (let c = 0; c < 3; c++) {
      out[j * 3 + c] = (lm[a + c] ?? 0) * (1 - au) + (lm[a + 3 + c] ?? 0) * au;
    }
  }
  return rows;
}

/**
 * Row by row, as the current renderer does: a row's floor (or ceiling) points step evenly across it. Light is blended
 * between the four nearest samples: near a lamp it changes too fast for flat 1/8-tile cells.
 */
function drawFloorAndCeiling(): void {
  const stride = world.w * FLOOR_SUB;
  const rows = world.h * FLOOR_SUB;
  const step = 2 / W;
  for (let y = 0; y < H; y++) {
    const below = y + 0.5 > half;
    const slope = Math.abs(y + 0.5 - half) / proj;
    const t = (below ? EYE : 1 - EYE) / slope;
    // Sample centres sit at cell + 0.5: shifting by half a cell makes the blend's corner cell a plain floor().
    let x = (eyeX + (dirX + planeX * (step / 2 - 1)) * t) * FLOOR_SUB - 0.5;
    let z = (eyeY + (dirY + planeY * (step / 2 - 1)) * t) * FLOOR_SUB - 0.5;
    const dx = planeX * step * t * FLOOR_SUB;
    const dz = planeY * step * t * FLOOR_SUB;
    const lm = below ? maps.floor : maps.ceiling;
    const albedo = below ? world.floorAlbedo : world.ceilingAlbedo;
    const ar = albedo[0] ?? 0;
    const ag = albedo[1] ?? 0;
    const ab = albedo[2] ?? 0;
    const row = y * W;
    for (let col = 0; col < W; col++, x += dx, z += dz) {
      if (below ? y < (colEnd[col] ?? 0) : y >= (colStart[col] ?? 0)) {
        continue;
      }
      const fx = x < 0 ? 0 : x > stride - 1.001 ? stride - 1.001 : x;
      const fz = z < 0 ? 0 : z > rows - 1.001 ? rows - 1.001 : z;
      const cx = fx | 0;
      const cz = fz | 0;
      const ax = fx - cx;
      const az = fz - cz;
      const a = (cz * stride + cx) * 3;
      const c = a + stride * 3;
      const wa = (1 - ax) * (1 - az);
      const wb = ax * (1 - az);
      const wc = (1 - ax) * az;
      const wd = ax * az;
      const i = row + col;
      hdr[i * 3] = ((lm[a] ?? 0) * wa + (lm[a + 3] ?? 0) * wb + (lm[c] ?? 0) * wc + (lm[c + 3] ?? 0) * wd) * ar;
      hdr[i * 3 + 1] = ((lm[a + 1] ?? 0) * wa + (lm[a + 4] ?? 0) * wb + (lm[c + 1] ?? 0) * wc + (lm[c + 4] ?? 0) * wd) * ag;
      hdr[i * 3 + 2] = ((lm[a + 2] ?? 0) * wa + (lm[a + 5] ?? 0) * wb + (lm[c + 2] ?? 0) * wc + (lm[c + 5] ?? 0) * wd) * ab;
      spec[i] = below ? (floorFresnel[i] ?? 0) : 0;
      specTile[i] = 0;
      if (!below && lampOver(world, (x + 0.5) / FLOOR_SUB, (z + 0.5) / FLOOR_SUB) >= 0) {
        hdr[i * 3] = world.lampRgb[0] ?? 0;
        hdr[i * 3 + 1] = world.lampRgb[1] ?? 0;
        hdr[i * 3 + 2] = world.lampRgb[2] ?? 0;
      }
    }
  }
}

/** People and lamps in this column, far to near, over what's behind them. */
function drawRoundThings(col: number): void {
  const base = col * MAX_ROUND_PER_RAY;
  for (let k = (colRound[col] ?? 0) - 1; k >= 0; k--) {
    const s = colRoundS[base + k] ?? 0;
    const who = colRoundWho[base + k] ?? 0;
    if (who >= people.length) {
      continue;
    }
    const r = roundR[who] ?? 0;
    const zc = roundZ[who] ?? 0;
    const across = -(colRoundO[base + k] ?? 0) / r;
    if (across >= 1 || across <= -1) {
      continue;
    }
    const top = half - ((zc + r - EYE) * proj) / s;
    const bottom = half - ((zc - r - EYE) * proj) / s;
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(H, Math.ceil(bottom)); y++) {
      const up = (EYE + ((half - (y + 0.5)) * s) / proj - zc) / r;
      if (across * across + up * up < 1) {
        const p = people[who] as Person;
        const texel = faceTexelAt(across, up);
        const i = y * W + col;
        screen[i] = texel < 0 ? p.ringSrgb : (p.faceSrgb[texel] ?? 0);
        spec[i] = SCREEN;
      }
    }
  }
}

/** Schlick's Fresnel, held down on rough surfaces (they never turn into mirrors at grazing angles). */
function fresnel(cos: number, m: Material): number {
  const c = 1 - Math.min(1, Math.max(0, cos));
  const c2 = c * c;
  return m.f0 + (Math.max(1 - m.roughness, m.f0) - m.f0) * c2 * c2 * c;
}

/**
 * Round things (people, lamps) a 2D ray from (ox, oy) along (rdx, rdy) passes close to before maxS, nearest first:
 * where along it (s) and how far to its side (o, tiles). Close is within the thing's radius, plus three times the
 * reflection cone's spread at that distance (spreadPerS per unit s) when the list serves reflections.
 */
function roundAlong(
  ox: number,
  oy: number,
  rdx: number,
  rdy: number,
  maxS: number,
  spreadPerS: number,
  outS: Float64Array,
  outO: Float64Array,
  outWho: Int16Array,
  base: number
): number {
  const len2 = rdx * rdx + rdy * rdy;
  const len = Math.sqrt(len2);
  let n = 0;
  for (let i = 0; i < rounds && n < MAX_ROUND_PER_RAY; i++) {
    const rx = (roundX[i] ?? 0) - ox;
    const ry = (roundY[i] ?? 0) - oy;
    const s = (rx * rdx + ry * rdy) / len2;
    if (s <= 0.05 || s >= maxS) {
      continue;
    }
    const o = (rdx * ry - rdy * rx) / len;
    const reach = (roundR[i] ?? 0) + Math.min(MAX_MARGIN, 3 * spreadPerS * s);
    if (o >= reach || o <= -reach) {
      continue;
    }
    let k = n++;
    while (k > 0 && (outS[base + k - 1] ?? 0) > s) {
      outS[base + k] = outS[base + k - 1] ?? 0;
      outO[base + k] = outO[base + k - 1] ?? 0;
      outWho[base + k] = outWho[base + k - 1] ?? 0;
      k--;
    }
    outS[base + k] = s;
    outO[base + k] = o;
    outWho[base + k] = i;
  }
  return n;
}

// One shading function per kind of thing, used by direct view and reflections alike.

function shadeRound(who: number, across: number, up: number): void {
  if (who >= people.length) {
    shade.set(world.lampRgb);
    return;
  }
  const p = people[who] as Person;
  const texel = faceTexelAt(across, up);
  const src = texel < 0 ? p.ring : p.face;
  const at = texel < 0 ? 0 : texel * 3;
  shade[0] = (src[at] ?? 0) * FACE_GAIN;
  shade[1] = (src[at + 1] ?? 0) * FACE_GAIN;
  shade[2] = (src[at + 2] ?? 0) * FACE_GAIN;
}

/**
 * A wall seen through a cone this wide (tiles): its texture fades to its average colour as the cone outgrows a brick.
 * `light` is the wall's light up that column, at the face's sample heights (from blendColumnLight), from `at`.
 */
function shadeWallSeen(tile: number, u: number, z: number, width: number, light: Float32Array, at: number): void {
  const texX = Math.min(TEXELS - 1, Math.floor(u * TEXELS));
  const texY = Math.min(TEXELS - 1, Math.floor((1 - z) * TEXELS));
  const albedo = world.albedo[tile] as Float32Array;
  const mean = world.meanAlbedo[tile] as Float32Array;
  const a = (texY * TEXELS + texX) * 3;
  const m = width >= TEXTURE_DETAIL ? 1 : width / TEXTURE_DETAIL;
  const heights = maps.wallV;
  const fz = z * (heights - 1);
  const j = fz >= heights - 1 ? heights - 2 : fz | 0;
  const az = fz - j;
  const l = at + j * 3;
  lightR = (light[l] ?? 0) + ((light[l + 3] ?? 0) - (light[l] ?? 0)) * az;
  lightG = (light[l + 1] ?? 0) + ((light[l + 4] ?? 0) - (light[l + 1] ?? 0)) * az;
  lightB = (light[l + 2] ?? 0) + ((light[l + 5] ?? 0) - (light[l + 2] ?? 0)) * az;
  shade[0] = ((albedo[a] ?? 0) * (1 - m) + (mean[0] ?? 0) * m) * lightR;
  shade[1] = ((albedo[a + 1] ?? 0) * (1 - m) + (mean[1] ?? 0) * m) * lightG;
  shade[2] = ((albedo[a + 2] ?? 0) * (1 - m) + (mean[2] ?? 0) * m) * lightB;
}

/** The floor or ceiling seen through a cone this wide (tiles): its light softens as the cone grows. */
function shadePlaneSeen(lm: Float32Array, soft: Float32Array, albedo: Float32Array, x: number, y: number, width: number) {
  const m = width >= LIGHT_DETAIL ? 1 : width / LIGHT_DETAIL;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  if (m > 0) {
    planeLight(soft, x, y);
    sr = lightR;
    sg = lightG;
    sb = lightB;
  }
  if (m < 1) {
    planeLight(lm, x, y);
  }
  shade[0] = (albedo[0] ?? 0) * (lightR * (1 - m) + sr * m);
  shade[1] = (albedo[1] ?? 0) * (lightG * (1 - m) + sg * m);
  shade[2] = (albedo[2] ?? 0) * (lightB * (1 - m) + sb * m);
}

/** The baked light on the floor or ceiling at (x, y), blended between its samples. */
function planeLight(lm: Float32Array, x: number, y: number): void {
  const stride = world.w * FLOOR_SUB;
  const rows = world.h * FLOOR_SUB;
  const fx = Math.min(stride - 1.001, Math.max(0, x * FLOOR_SUB - 0.5));
  const fy = Math.min(rows - 1.001, Math.max(0, y * FLOOR_SUB - 0.5));
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const ax = fx - i0;
  const ay = fy - j0;
  const a = (j0 * stride + i0) * 3;
  const c = a + stride * 3;
  const wa = (1 - ax) * (1 - ay);
  const wb = ax * (1 - ay);
  const wc = (1 - ax) * ay;
  const wd = ax * ay;
  lightR = (lm[a] ?? 0) * wa + (lm[a + 3] ?? 0) * wb + (lm[c] ?? 0) * wc + (lm[c + 3] ?? 0) * wd;
  lightG = (lm[a + 1] ?? 0) * wa + (lm[a + 4] ?? 0) * wb + (lm[c + 1] ?? 0) * wc + (lm[c + 4] ?? 0) * wd;
  lightB = (lm[a + 2] ?? 0) * wa + (lm[a + 5] ?? 0) * wb + (lm[c + 2] ?? 0) * wc + (lm[c + 5] ?? 0) * wd;
}

// Reflections, at 1/SCALE resolution: what each reflecting pixel's cone meets.

function traceReflections(): void {
  const offset = SCALE >> 1;
  for (let rx = 0; rx < RW; rx++) {
    const col = rx * SCALE + offset;
    const start = colStart[col] ?? 0;
    const end = colEnd[col] ?? 0;
    // Rows of the reflection buffer: ceiling (matte) above wallTop, the wall to floorTop, the floor below.
    const wallTop = Math.min(RH, Math.max(0, Math.ceil((start - offset) / SCALE)));
    const floorTop = Math.min(RH, Math.max(wallTop, Math.ceil((end - offset) / SCALE)));
    for (let ry = 0; ry < wallTop; ry++) {
      const i = (ry * RW + rx) * 3;
      reflected[i] = 0;
      reflected[i + 1] = 0;
      reflected[i + 2] = 0;
    }
    if (floorTop > wallTop) {
      mirrorOffWall(col);
      // A rough wall's cone is wide: what it reflects barely changes from row to row, so every 4th row will do.
      const step = wallAlpha > 0.25 ? 4 : 1;
      let last = -1;
      for (let ry = wallTop; ry < floorTop; ry += step) {
        traceWallRow(col, rx, ry, offset);
        fillBetween(rx, last, ry);
        last = ry;
      }
      if (last !== floorTop - 1) {
        traceWallRow(col, rx, floorTop - 1, offset);
        fillBetween(rx, last, floorTop - 1);
      }
    }
    for (let ry = floorTop; ry < RH; ry++) {
      reflectOffFloor(col, ry * SCALE + offset);
      const i = (ry * RW + rx) * 3;
      reflected[i] = shade[0] ?? 0;
      reflected[i + 1] = shade[1] ?? 0;
      reflected[i + 2] = shade[2] ?? 0;
    }
  }
}

function traceWallRow(col: number, rx: number, ry: number, offset: number): void {
  reflectOffWall(col, ry * SCALE + offset);
  const i = (ry * RW + rx) * 3;
  reflected[i] = shade[0] ?? 0;
  reflected[i + 1] = shade[1] ?? 0;
  reflected[i + 2] = shade[2] ?? 0;
}

/** Blends the reflection buffer's rows strictly between `from` and `to` in column rx (nothing when from < 0). */
function fillBetween(rx: number, from: number, to: number): void {
  if (from < 0) {
    return;
  }
  const a = (from * RW + rx) * 3;
  const b = (to * RW + rx) * 3;
  for (let ry = from + 1; ry < to; ry++) {
    const f = (ry - from) / (to - from);
    const i = (ry * RW + rx) * 3;
    reflected[i] = (reflected[a] ?? 0) * (1 - f) + (reflected[b] ?? 0) * f;
    reflected[i + 1] = (reflected[a + 1] ?? 0) * (1 - f) + (reflected[b + 1] ?? 0) * f;
    reflected[i + 2] = (reflected[a + 2] ?? 0) * (1 - f) + (reflected[b + 2] ?? 0) * f;
  }
}

// The ray mirrored off the column's wall: one 2D direction for the whole column, so one walk.
let mirrorX = 0;
let mirrorY = 0;
let mirrorDx = 0;
let mirrorDy = 0;
let mirrorLen = 1;
let mirrorFaceIndex = -1;
let mirrorRound = 0;
let wallAlpha = 0;
/** |n · ray| for the column's wall: with the ray's climb, how squarely it meets the wall. */
let wallFacing = 1;

function mirrorOffWall(col: number): void {
  const rdx = colRdx[col] ?? 0;
  const rdy = colRdy[col] ?? 0;
  const d = colD[col] ?? 0;
  const face = colFace[col] ?? 0;
  const nx = FACE_NX[face] ?? 0;
  const ny = FACE_NY[face] ?? 0;
  mirrorDx = nx !== 0 ? -rdx : rdx;
  mirrorDy = ny !== 0 ? -rdy : rdy;
  mirrorLen = Math.sqrt(rdx * rdx + rdy * rdy);
  mirrorX = eyeX + rdx * d + nx * 1e-4;
  mirrorY = eyeY + rdy * d + ny * 1e-4;
  castRay(world.map, mirrorX, mirrorY, mirrorDx, mirrorDy, mirrorHit);
  const hitFace = mirrorHit.side === 0 ? (mirrorDx > 0 ? FACE_W : FACE_E) : mirrorDy > 0 ? FACE_N : FACE_S;
  mirrorFaceIndex = world.faceIndex[(mirrorHit.mapY * world.w + mirrorHit.mapX) * 4 + hitFace] ?? -1;
  blendColumnLight(mirrorFaceIndex, mirrorHit.wallX, mirrorLight);
  const m = (MATERIALS[colTile[col] ?? 1] ?? FLOOR_MATERIAL) as Material;
  wallAlpha = m.roughness * m.roughness;
  wallFacing = Math.abs(nx * rdx + ny * rdy);
  // Off a wall the cone stretches sideways, towards the eye, by 1 / slant.
  const slant = Math.max(GRAZING_MIN, wallFacing / mirrorLen);
  const spreadPerS = (wallAlpha * mirrorLen) / slant;
  mirrorRound = roundAlong(
    mirrorX,
    mirrorY,
    mirrorDx,
    mirrorDy,
    mirrorHit.distance,
    spreadPerS,
    mirrorRoundS,
    mirrorRoundO,
    mirrorRoundWho,
    0
  );
}

/** Fills shade with what the cone off the column's wall at row y meets: the far wall, the floor or ceiling, things. */
function reflectOffWall(col: number, y: number): void {
  const d = colD[col] ?? 0;
  const k = (half - (y + 0.5)) / proj;
  const zh = EYE + k * d;
  const slant = Math.max(GRAZING_MIN, wallFacing / Math.sqrt(mirrorLen * mirrorLen + k * k));
  const sWall = mirrorHit.distance;
  const zWall = zh + k * sWall;
  const toWall = sWall * mirrorLen;
  const edge = Math.max(EDGE_MIN, wallAlpha * toWall);
  // How much of the cone meets the far wall rather than the floor or ceiling past its foot or top.
  let wallShare = 1;
  if (k > 0) {
    wallShare = clamp01((1 + edge - zWall) / (2 * edge));
  } else if (k < 0) {
    wallShare = clamp01((zWall + edge) / (2 * edge));
  }
  let r = 0;
  let g = 0;
  let b = 0;
  if (wallShare > 0) {
    shadeWallSeen(mirrorHit.tile, mirrorHit.wallX, clamp01(zWall), wallAlpha * toWall, mirrorLight, 0);
    r = (shade[0] ?? 0) * wallShare;
    g = (shade[1] ?? 0) * wallShare;
    b = (shade[2] ?? 0) * wallShare;
  }
  if (wallShare < 1) {
    const ceiling = k > 0;
    const s = ceiling ? (1 - zh) / k : -zh / k;
    shadePlaneSeen(
      ceiling ? maps.ceiling : maps.floor,
      ceiling ? maps.ceilingSoft : maps.floorSoft,
      ceiling ? world.ceilingAlbedo : world.floorAlbedo,
      mirrorX + mirrorDx * s,
      mirrorY + mirrorDy * s,
      wallAlpha * s * mirrorLen
    );
    r += (shade[0] ?? 0) * (1 - wallShare);
    g += (shade[1] ?? 0) * (1 - wallShare);
    b += (shade[2] ?? 0) * (1 - wallShare);
  }
  shade[0] = r;
  shade[1] = g;
  shade[2] = b;
  const toCeiling = k > 0 ? { s: (1 - zh) / k, share: 1 - wallShare } : NO_CEILING;
  meetRoundThings(mirrorRoundS, mirrorRoundO, mirrorRoundWho, 0, mirrorRound, 0, zh, k, mirrorLen, wallAlpha, slant, false, toCeiling);
}

/** Fills shade with what the cone off the floor at row y meets: the column's wall, or the ceiling past its top, things. */
function reflectOffFloor(col: number, y: number): void {
  const rdx = colRdx[col] ?? 0;
  const rdy = colRdy[col] ?? 0;
  const d = colD[col] ?? 0;
  const len = Math.sqrt(rdx * rdx + rdy * rdy);
  const slope = (y + 0.5 - half) / proj;
  const t = EYE / slope;
  const slant = Math.max(GRAZING_MIN, slope / Math.sqrt(len * len + slope * slope));
  // Off the floor the mirrored ray keeps the column's direction, climbing as steeply as the view ray fell.
  const zWall = slope * (d - t);
  const toWall = Math.max(0, d - t) * len;
  const edge = Math.max(EDGE_MIN, (FLOOR_ALPHA * toWall) / slant);
  const wallShare = clamp01((1 + edge - zWall) / (2 * edge));
  let r = 0;
  let g = 0;
  let b = 0;
  if (wallShare > 0) {
    shadeWallSeen(colTile[col] ?? 1, colU[col] ?? 0, clamp01(zWall), FLOOR_ALPHA * toWall, columnLights, col * 3 * 8);
    r = (shade[0] ?? 0) * wallShare;
    g = (shade[1] ?? 0) * wallShare;
    b = (shade[2] ?? 0) * wallShare;
  }
  if (wallShare < 1) {
    const s = t + 1 / slope;
    shadePlaneSeen(
      maps.ceiling,
      maps.ceilingSoft,
      world.ceilingAlbedo,
      eyeX + rdx * s,
      eyeY + rdy * s,
      (FLOOR_ALPHA * len) / slope
    );
    r += (shade[0] ?? 0) * (1 - wallShare);
    g += (shade[1] ?? 0) * (1 - wallShare);
    b += (shade[2] ?? 0) * (1 - wallShare);
  }
  shade[0] = r;
  shade[1] = g;
  shade[2] = b;
  const base = col * MAX_ROUND_PER_RAY;
  ceilingMeet.s = t + 1 / slope;
  ceilingMeet.share = 1 - wallShare;
  meetRoundThings(colRoundS, colRoundO, colRoundWho, base, colRound[col] ?? 0, t, 0, slope, len, FLOOR_ALPHA, slant, true, ceilingMeet);
}

/** Where a reflection's centre ray reaches the ceiling (s) and how much of its cone gets there past the walls. */
interface CeilingMeet {
  s: number;
  share: number;
}
const NO_CEILING: CeilingMeet = { s: 0, share: 0 };
const ceilingMeet: CeilingMeet = { s: 0, share: 0 };

/**
 * Lays the round things a reflection cone passes over shade, far to near. The cone leaves the surface at sFrom, at
 * height z0, climbing zPerS per unit of s; it is alpha wide per tile travelled, and 1 / slant times that along the
 * view (up the screen off the floor, across it off a wall). A thing meets it as a soft blob: the thing blurred by the
 * cone, as bright overall as the thing itself. A person covers what's behind, sharp (with the face) while the cone is
 * still narrow; a lamp, a disc in the ceiling, adds its light where the cone reaches the ceiling.
 */
function meetRoundThings(
  listS: Float64Array,
  listO: Float64Array,
  listWho: Int16Array,
  base: number,
  n: number,
  sFrom: number,
  z0: number,
  zPerS: number,
  len: number,
  alpha: number,
  slant: number,
  stretchUp: boolean,
  ceiling: CeilingMeet
): void {
  for (let k = n - 1; k >= 0; k--) {
    const s = listS[base + k] ?? 0;
    if (s <= sFrom) {
      continue;
    }
    const who = listWho[base + k] ?? 0;
    const r = roundR[who] ?? 0;
    const o = listO[base + k] ?? 0;
    if (who >= people.length) {
      if (ceiling.share > 0) {
        addCeilingLamp(s, o, r, sFrom, zPerS, len, alpha, slant, stretchUp, ceiling);
      }
      continue;
    }
    const dz = z0 + zPerS * (s - sFrom) - (roundZ[who] ?? 0);
    const cone = alpha * (s - sFrom) * len;
    if (cone < SHARP * r) {
      const across = -o / r;
      const up = dz / r;
      if (across * across + up * up < 1) {
        shadeRound(who, across, up);
      }
      continue;
    }
    const spreadAcross = stretchUp ? cone : cone / slant;
    const spreadUp = stretchUp ? cone / slant : cone;
    const ball = (r * r) / 4;
    const across2 = ball + spreadAcross * spreadAcross;
    const up2 = ball + spreadUp * spreadUp;
    const falloff = (o * o) / (2 * across2) + (dz * dz) / (2 * up2);
    if (falloff > 9) {
      continue;
    }
    const w = Math.min(1, (r * r) / (2 * Math.sqrt(across2 * up2))) * Math.exp(-falloff);
    const p = people[who] as Person;
    const keep = 1 - w;
    shade[0] = (shade[0] ?? 0) * keep + (p.faceMean[0] ?? 0) * FACE_GAIN * w;
    shade[1] = (shade[1] ?? 0) * keep + (p.faceMean[1] ?? 0) * FACE_GAIN * w;
    shade[2] = (shade[2] ?? 0) * keep + (p.faceMean[2] ?? 0) * FACE_GAIN * w;
  }
}

/**
 * A ceiling lamp at s along the ray, o to its side, in a cone that reaches the ceiling at ceiling.s: the cone's
 * footprint there is stretched along the ray by how low it comes in (1 / rise), so off a glossy floor a lamp far down
 * a corridor becomes a long streak.
 */
function addCeilingLamp(
  s: number,
  o: number,
  r: number,
  sFrom: number,
  zPerS: number,
  len: number,
  alpha: number,
  slant: number,
  stretchUp: boolean,
  ceiling: CeilingMeet
): void {
  const length = Math.sqrt(len * len + zPerS * zPerS);
  const cone = alpha * (ceiling.s - sFrom) * length;
  const rise = Math.max(GRAZING_MIN, zPerS / length);
  const spreadAcross = stretchUp ? cone : cone / slant;
  const spreadAlong = (stretchUp ? cone / slant : cone) / rise;
  const along = (s - ceiling.s) * len;
  const disc = (r * r) / 4;
  const across2 = disc + spreadAcross * spreadAcross;
  const along2 = disc + spreadAlong * spreadAlong;
  const falloff = (o * o) / (2 * across2) + (along * along) / (2 * along2);
  if (falloff > 9) {
    return;
  }
  const w = Math.min(1, (r * r) / (2 * Math.sqrt(across2 * along2))) * Math.exp(-falloff) * ceiling.share;
  shade[0] = (shade[0] ?? 0) + (world.lampRgb[0] ?? 0) * w;
  shade[1] = (shade[1] ?? 0) + (world.lampRgb[1] ?? 0) * w;
  shade[2] = (shade[2] ?? 0) + (world.lampRgb[2] ?? 0) * w;
}

/**
 * Diffuse plus reflection (blended up from its own resolution, tinted by the surface), weighted by Fresnel, then
 * exposed and toned.
 */
function composite(pixels: Uint32Array, settings: TraceSettings): void {
  const exposure = settings.exposure;
  const top = TONE_SIZE - 1;
  const encodeTop = ENCODE_SIZE - 1;
  const reflections = settings.reflections;
  if (reflections) {
    widenReflections();
    fillTints();
  }
  for (let y = 0; y < H; y++) {
    const ay = upAY[y] ?? 0;
    const row0 = (upY0[y] ?? 0) * W * 3;
    const row1 = Math.min(RH - 1, (upY0[y] ?? 0) + 1) * W * 3;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const f = spec[i] ?? 0;
      if (f === SCREEN) {
        pixels[i] = screen[i] ?? 0;
        continue;
      }
      let r = hdr[i * 3] ?? 0;
      let g = hdr[i * 3 + 1] ?? 0;
      let b = hdr[i * 3 + 2] ?? 0;
      if (reflections && f > 0) {
        const p = row0 + x * 3;
        const q = row1 + x * 3;
        const t = (specTile[i] ?? 0) * 3;
        const keep = 1 - f;
        const p0 = widened[p] ?? 0;
        const p1 = widened[p + 1] ?? 0;
        const p2 = widened[p + 2] ?? 0;
        r = r * keep + f * (tintRgb[t] ?? 1) * (p0 + ((widened[q] ?? 0) - p0) * ay);
        g = g * keep + f * (tintRgb[t + 1] ?? 1) * (p1 + ((widened[q + 1] ?? 0) - p1) * ay);
        b = b * keep + f * (tintRgb[t + 2] ?? 1) * (p2 + ((widened[q + 2] ?? 0) - p2) * ay);
      }
      r *= exposure;
      g *= exposure;
      b *= exposure;
      const peak = r > g ? (r > b ? r : b) : g > b ? g : b;
      const at = Math.min(top, (peak * TONE_STEPS) | 0);
      // Past the table e^-x is nothing: the brightest channel goes to 1.
      const scale = at === top ? 1 / peak : (TONE_SCALE[at] ?? 0);
      const white = TONE_WHITE[at] ?? 0;
      const shown = peak * scale;
      r *= scale;
      g *= scale;
      b *= scale;
      if (white > 0) {
        r += (shown - r) * white;
        g += (shown - g) * white;
        b += (shown - b) * white;
      }
      const tr = ENCODE[(r * encodeTop) | 0] ?? 0;
      const tg = ENCODE[(g * encodeTop) | 0] ?? 0;
      const tb = ENCODE[(b * encodeTop) | 0] ?? 0;
      pixels[i] = (0xff000000 | (tb << 16) | (tg << 8) | tr) >>> 0;
    }
  }
}

/** Each material's reflection colour: white, blended by its tint towards its average colour at full brightness. */
function fillTints(): void {
  for (let tile = 0; tile < MATERIALS.length; tile++) {
    const tint = (MATERIALS[tile] as Material).tint;
    const mean = tile === 0 ? world.floorAlbedo : (world.meanAlbedo[tile] as Float32Array);
    const top = Math.max(mean[0] ?? 0, mean[1] ?? 0, mean[2] ?? 0) || 1;
    for (let c = 0; c < 3; c++) {
      tintRgb[tile * 3 + c] = 1 - tint + (tint * (mean[c] ?? 0)) / top;
    }
  }
}

/** Blends each reflection row out to the frame's width; composite then only blends between two such rows. */
function widenReflections(): void {
  for (let ry = 0; ry < RH; ry++) {
    const src = ry * RW * 3;
    const dst = ry * W * 3;
    for (let x = 0; x < W; x++) {
      const ax = upAX[x] ?? 0;
      const p = src + (upX0[x] ?? 0) * 3;
      const q = src + Math.min(RW - 1, (upX0[x] ?? 0) + 1) * 3;
      const o = dst + x * 3;
      const p0 = reflected[p] ?? 0;
      const p1 = reflected[p + 1] ?? 0;
      const p2 = reflected[p + 2] ?? 0;
      widened[o] = p0 + ((reflected[q] ?? 0) - p0) * ax;
      widened[o + 1] = p1 + ((reflected[q + 1] ?? 0) - p1) * ax;
      widened[o + 2] = p2 + ((reflected[q + 2] ?? 0) - p2) * ax;
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
