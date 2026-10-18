// The room as the ray tracer sees it: LEVEL1's grid, its corridor lamps as glowing discs set in the ceiling, and
// every surface's colour in linear light. Throwaway spike: see README.md.
import { type GameMap, LEVEL1, parseMap } from '@zoom3d/shared';
import { corridorLights } from '../../apps/web/src/renderer/lighting';
import { averageColour, GLOSS, makeTextures, TEX } from '../../apps/web/src/renderer/textures';
import { CEILING, FLOOR } from '../../apps/web/src/renderer/walls';

/** A lamp is a glowing disc this wide (tiles) set in the ceiling, shining down: the game's fixture (FIXTURE_RADIUS). */
export const LAMP_RADIUS = 0.18;
/** The disc's brightness: about 1 on the floor right under it. */
export const LAMP_RADIANCE = 36;
/**
 * The current renderer's lamp colour, LAMP (1.25, 1.05, 0.75): 1, 0.84, 0.6 as a tint. It tints screen colours; in
 * linear light the same warmth on screen is that tint to the power 2.2.
 */
const LAMP_TINT = [1, 0.84 ** 2.2, 0.6 ** 2.2] as const;

/**
 * How a surface reflects: f0 face-on (0.04 for any varnish, paint or stone), roughness 0 mirror .. 1 matte, and tint,
 * how much what it reflects takes on its own colour (0 the light's colour; varnish over wood glows golden).
 */
export interface Material {
  f0: number;
  roughness: number;
  tint: number;
}
/** Index = tile id; 0 is the floor. */
export const MATERIALS: readonly Material[] = [
  { f0: 0.04, roughness: 0.6, tint: 0 },
  { f0: 0.04, roughness: 0.85, tint: 0.6 },
  { f0: 0.04, roughness: 0.35, tint: 0.75 },
  { f0: 0.04, roughness: 0.85, tint: 0.85 },
];

export const FACE_W = 0;
export const FACE_E = 1;
export const FACE_N = 2;
export const FACE_S = 3;
/** Each face's normal, pointing into the open cell in front of it. */
export const FACE_NX = [-1, 1, 0, 0] as const;
export const FACE_NY = [0, 0, -1, 1] as const;

export interface World {
  map: GameMap;
  w: number;
  h: number;
  solid: Uint8Array;
  /** Per wall cell and face (cell × 4 + FACE_*), its index among visible faces, or -1 where no floor is in front. */
  faceIndex: Int32Array;
  faces: number;
  lampX: Float64Array;
  lampY: Float64Array;
  /** Per tile, the lamp whose disc reaches over it, or -1. */
  lampAt: Int16Array;
  /** The lamp's radiance, linear RGB. */
  lampRgb: Float32Array;
  /** sRGB textures, index = tile id (for the current renderer). */
  textures: Uint32Array[];
  /** Linear RGB per texel, index = tile id. */
  albedo: Float32Array[];
  meanAlbedo: Float32Array[];
  gloss: readonly Uint8Array[];
  floorAlbedo: Float32Array;
  ceilingAlbedo: Float32Array;
  /**
   * What a surface throws back in the bake, per tile id, then the floor's and ceiling's: its colour as painted, not
   * converted to linear light (which would make it throw back only a third to a fifth as much), so walls tint what is
   * near them about as strongly as they look.
   */
  bounceAlbedo: Float32Array[];
  floorBounce: Float32Array;
  ceilingBounce: Float32Array;
}

const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export function linearOf(packed: number): Float32Array {
  return Float32Array.of(
    SRGB_TO_LINEAR[packed & 0xff] ?? 0,
    SRGB_TO_LINEAR[(packed >>> 8) & 0xff] ?? 0,
    SRGB_TO_LINEAR[(packed >>> 16) & 0xff] ?? 0
  );
}

/** A packed colour's channels as painted, 0..1. */
function paintedOf(packed: number): Float32Array {
  return Float32Array.of((packed & 0xff) / 255, ((packed >>> 8) & 0xff) / 255, ((packed >>> 16) & 0xff) / 255);
}

export function makeWorld(): World {
  const map = parseMap(LEVEL1);
  const { width: w, height: h } = map;
  const solid = new Uint8Array(w * h).map((_, i) => (map.tiles[i] === 0 ? 0 : 1));
  const { faceIndex, faces } = indexFaces(w, h, solid);
  const lights = corridorLights(map);
  const lampAt = new Int16Array(w * h).fill(-1);
  lights.forEach((l, i) => {
    for (let ty = Math.floor(l.y - LAMP_RADIUS); ty <= Math.floor(l.y + LAMP_RADIUS); ty++) {
      for (let tx = Math.floor(l.x - LAMP_RADIUS); tx <= Math.floor(l.x + LAMP_RADIUS); tx++) {
        lampAt[ty * w + tx] = i;
      }
    }
  });
  const textures = makeTextures(1);
  const albedo = textures.map((tex) => {
    const out = new Float32Array(tex.length * 3);
    tex.forEach((c, i) => out.set(linearOf(c), i * 3));
    return out;
  });
  const meanAlbedo = albedo.map((a) => {
    const n = a.length / 3 || 1;
    const out = new Float32Array(3);
    for (let i = 0; i < a.length; i += 3) {
      out[0] = (out[0] ?? 0) + (a[i] ?? 0) / n;
      out[1] = (out[1] ?? 0) + (a[i + 1] ?? 0) / n;
      out[2] = (out[2] ?? 0) + (a[i + 2] ?? 0) / n;
    }
    return out;
  });
  return {
    map,
    w,
    h,
    solid,
    faceIndex,
    faces,
    lampX: Float64Array.from(lights, (l) => l.x),
    lampY: Float64Array.from(lights, (l) => l.y),
    lampAt,
    lampRgb: Float32Array.from(LAMP_TINT, (c) => c * LAMP_RADIANCE),
    textures,
    albedo,
    meanAlbedo,
    gloss: GLOSS,
    floorAlbedo: linearOf(FLOOR),
    ceilingAlbedo: linearOf(CEILING),
    bounceAlbedo: textures.map((tex) => paintedOf(tex.length ? averageColour(tex) : 0)),
    floorBounce: paintedOf(FLOOR),
    ceilingBounce: paintedOf(CEILING),
  };
}

export function isSolid(world: World, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.w || y >= world.h) {
    return true;
  }
  return world.solid[y * world.w + x] === 1;
}

/** The lamp whose disc covers ceiling point (x, y), or -1. */
export function lampOver(world: World, x: number, y: number): number {
  const lamp = world.lampAt[Math.floor(y) * world.w + Math.floor(x)] ?? -1;
  if (lamp < 0) {
    return -1;
  }
  const dx = x - (world.lampX[lamp] ?? 0);
  const dy = y - (world.lampY[lamp] ?? 0);
  return dx * dx + dy * dy < LAMP_RADIUS * LAMP_RADIUS ? lamp : -1;
}

export const TEXELS = TEX;

function indexFaces(w: number, h: number, solid: Uint8Array): { faceIndex: Int32Array; faces: number } {
  const faceIndex = new Int32Array(w * h * 4).fill(-1);
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x] === 0;
  let faces = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (solid[y * w + x] === 0) {
        continue;
      }
      for (let f = 0; f < 4; f++) {
        if (open(x + (FACE_NX[f] ?? 0), y + (FACE_NY[f] ?? 0))) {
          faceIndex[(y * w + x) * 4 + f] = faces++;
        }
      }
    }
  }
  return { faceIndex, faces };
}
