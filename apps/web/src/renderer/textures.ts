// Procedural 64x64 wall textures, deterministic per seed. Index = tile id (0 unused).
import { rgb } from './framebuffer';

export const TEX = 64;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Paint = (x: number, y: number, noise: number) => [number, number, number];

function texture(rand: () => number, paint: Paint): Uint32Array {
  const tex = new Uint32Array(TEX * TEX);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const [r, g, b] = paint(x, y, rand() * 2 - 1);
      tex[y * TEX + x] = rgb(r, g, b);
    }
  }
  return tex;
}

// Staggered blocks: 16 px rows, 32 px blocks, 2 px mortar.
function isMortar(x: number, y: number): boolean {
  const row = Math.floor(y / 16);
  const offset = row % 2 === 0 ? 0 : 16;
  return y % 16 < 2 || (x + offset) % 32 < 2;
}

export function makeTextures(seed = 1): Uint32Array[] {
  const rand = mulberry32(seed);
  const stone = texture(rand, (x, y, n) => {
    if (isMortar(x, y)) {
      return [70, 72, 70];
    }
    const v = 140 + n * 18;
    return [v, v + 2, v];
  });
  const wood = texture(rand, (x, y, n) => {
    const seam = x % 16 === 0;
    const grain = Math.sin((y + (x % 16) * 3) * 0.6) * 8;
    if (seam) {
      return [60, 38, 18];
    }
    return [122 + grain + n * 10, 80 + grain * 0.6 + n * 6, 40 + n * 4];
  });
  const blue = texture(rand, (x, y, n) => {
    if (isMortar(x, y)) {
      return [10, 10, 70];
    }
    return [12 + n * 6, 18 + n * 8, 150 + n * 25];
  });
  return [new Uint32Array(0), stone, wood, blue];
}
