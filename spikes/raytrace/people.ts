// Stand-in people: discs with an emoji for a face, some standing, some pacing a corridor, so their reflections move.
import { isSolid, linearOf, type World } from './world';

/** In tiles, like the game's AVATAR_RADIUS; the face fills the disc out to FACE_RADIUS of it, the ring is the rest. */
export const PERSON_RADIUS = 0.35;
const FACE_RADIUS = 0.85;
export const FACE_TEXELS = 32;
const EMOJI = ['😀', '🧑‍💻', '👩‍🦰', '🧔', '😎', '🤓', '👵', '🥳'];
const RINGS = [0xff4f8bff, 0xff3cc46a, 0xff2fa0f5, 0xffd05ad0, 0xff40d0e0, 0xff7070ff, 0xff60e0a0, 0xffe09050];
const SPEED = 0.8;

export interface Person {
  x: number;
  y: number;
  /** Pacing direction (0, 0 standing). */
  dx: number;
  dy: number;
  /** Face texels, linear RGB and packed sRGB, and the face's average: what a blurry reflection shows of it. */
  face: Float32Array;
  faceMean: Float32Array;
  faceSrgb: Uint32Array;
  ring: Float32Array;
  ringSrgb: number;
}

export function makePeople(world: World, count: number): Person[] {
  let seed = 99;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const { spawn } = world.map;
  const near = openTilesNear(world, spawn.x, spawn.y, 9).filter((t) => Math.hypot(t.x - spawn.x, t.y - spawn.y) >= 2);
  const people: Person[] = [];
  for (let tries = 0; people.length < count && tries < 500; tries++) {
    const tile = near[Math.floor(rand() * near.length)];
    if (!tile || people.some((p) => Math.hypot(p.x - tile.x - 0.5, p.y - tile.y - 0.5) < 2)) {
      continue;
    }
    const i = people.length;
    const paces = i % 2 === 0;
    const across = runLength(world, tile.x, tile.y, 1, 0) >= runLength(world, tile.x, tile.y, 0, 1);
    const ring = RINGS[i % RINGS.length] ?? 0xffffffff;
    const face = faceTexels(EMOJI[i % EMOJI.length] ?? '🙂', ring);
    const faceLinear = linearTexels(face);
    people.push({
      x: tile.x + 0.5,
      y: tile.y + 0.5,
      dx: paces ? (across ? 1 : 0) : 0,
      dy: paces ? (across ? 0 : 1) : 0,
      face: faceLinear,
      faceMean: meanOf(faceLinear),
      faceSrgb: face,
      ring: linearOf(ring),
      ringSrgb: ring,
    });
  }
  return people;
}

export function stepPeople(world: World, people: Person[], dt: number): void {
  for (const p of people) {
    if (p.dx === 0 && p.dy === 0) {
      continue;
    }
    const nx = p.x + p.dx * SPEED * dt;
    const ny = p.y + p.dy * SPEED * dt;
    const aheadX = nx + p.dx * PERSON_RADIUS;
    const aheadY = ny + p.dy * PERSON_RADIUS;
    if (isSolid(world, Math.floor(aheadX), Math.floor(aheadY))) {
      p.dx = -p.dx;
      p.dy = -p.dy;
    } else {
      p.x = nx;
      p.y = ny;
    }
  }
}

/** Where on a person's disc a ray lands, (across, up) in radii, as a face texel or -1 for the ring. */
export function faceTexelAt(across: number, up: number): number {
  if (across * across + up * up >= FACE_RADIUS * FACE_RADIUS) {
    return -1;
  }
  const fx = Math.floor(((across / FACE_RADIUS) * 0.5 + 0.5) * FACE_TEXELS);
  const fy = Math.floor(((-up / FACE_RADIUS) * 0.5 + 0.5) * FACE_TEXELS);
  return Math.min(FACE_TEXELS - 1, Math.max(0, fy)) * FACE_TEXELS + Math.min(FACE_TEXELS - 1, Math.max(0, fx));
}

function faceTexels(emoji: string, ring: number): Uint32Array {
  const canvas = document.createElement('canvas');
  canvas.width = FACE_TEXELS;
  canvas.height = FACE_TEXELS;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = new Uint32Array(FACE_TEXELS * FACE_TEXELS);
  if (!ctx) {
    return out.fill(ring);
  }
  const r = ring & 0xff;
  const g = (ring >>> 8) & 0xff;
  const b = (ring >>> 16) & 0xff;
  ctx.fillStyle = `rgb(${(r + 2 * 40) / 3}, ${(g + 2 * 40) / 3}, ${(b + 2 * 48) / 3})`;
  ctx.fillRect(0, 0, FACE_TEXELS, FACE_TEXELS);
  ctx.font = `${FACE_TEXELS * 0.8}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, FACE_TEXELS / 2, FACE_TEXELS / 2 + 1);
  const data = ctx.getImageData(0, 0, FACE_TEXELS, FACE_TEXELS).data;
  for (let i = 0; i < out.length; i++) {
    out[i] =
      (0xff000000 | ((data[i * 4 + 2] ?? 0) << 16) | ((data[i * 4 + 1] ?? 0) << 8) | (data[i * 4] ?? 0)) >>> 0;
  }
  return out;
}

function meanOf(rgb: Float32Array): Float32Array {
  const out = new Float32Array(3);
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    out[0] = (out[0] ?? 0) + (rgb[i] ?? 0) / n;
    out[1] = (out[1] ?? 0) + (rgb[i + 1] ?? 0) / n;
    out[2] = (out[2] ?? 0) + (rgb[i + 2] ?? 0) / n;
  }
  return out;
}

function linearTexels(srgb: Uint32Array): Float32Array {
  const out = new Float32Array(srgb.length * 3);
  srgb.forEach((c, i) => out.set(linearOf(c), i * 3));
  return out;
}

function openTilesNear(world: World, sx: number, sy: number, radius: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = sy - radius; y <= sy + radius; y++) {
    for (let x = sx - radius; x <= sx + radius; x++) {
      if (!isSolid(world, x, y) && Math.hypot(x - sx, y - sy) <= radius) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

function runLength(world: World, x: number, y: number, dx: number, dy: number): number {
  let n = 1;
  for (let k = 1; !isSolid(world, x + dx * k, y + dy * k); k++) {
    n++;
  }
  for (let k = 1; !isSolid(world, x - dx * k, y - dy * k); k++) {
    n++;
  }
  return n;
}
