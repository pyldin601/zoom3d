// Billboard disc avatars, depth-tested per column against the wall z-buffer, each with a soft
// shadow on the floor right under it; voxel objects (the robot vacuum) are drawn in the same far-to-near order.
import type { HeldItem, PlayerState } from '@zoom3d/shared';
import { FACE_SIZE } from '../media/faces';
import type { PeerFacts } from '../media/interest';
import { BOOMBOX_LEFT, BOOMBOX_SPRITE, BOOMBOX_TOP } from './boombox';
import { createView, EYE_HEIGHT, MIN_DEPTH, setView, type View } from './camera';
import { type Framebuffer, rgb, scaleRgb } from './framebuffer';
import {
  CHEERS_LEFT,
  CHEERS_TOP,
  CHEERS_WOBBLE,
  HELD_LEFT,
  HELD_SPRITES,
  HELD_TEXEL,
  HELD_TOP,
  type HeldSprite,
  sipLeft,
  sipTop,
} from './held-items';
import type { Lighting } from './lighting';
import { type HeldPose, poseBlend } from './sip';
import { renderVoxel, type VoxelInstance, voxelDepth } from './voxels';

/** In tiles. */
export const AVATAR_RADIUS = 0.35;
/** The face fills the disc out to this fraction of its radius; the ring is the rest. */
const FACE_RADIUS = 0.85;
/** A flat disc's ring shows at 70% of its colour, like an unlit y-side wall (lighting.ts SIDE_SHADE). */
const FLAT_RING_SHADE = 0.7;
/** How far towards white the ring goes while its person talks at full loudness. */
const SPEAKING_GLOW = 0.8;
/** Floor shadow radius (tiles) and how much it darkens the floor at its centre. */
export const SHADOW_RADIUS = 0.3;
const SHADOW_DARKNESS = 0.33;
/** Retro look: the shadow is a low-res floor texture (texels per tile) with flat darkness bands. */
const SHADOW_TEXELS_PER_TILE = 16;
/** A shadow texel's side, in tiles. */
const SHADOW_TEXEL = 1 / SHADOW_TEXELS_PER_TILE;
export const SHADOW_LEVELS = 3;
/** Top of a walking step, in disc radii. */
export const BOB_HEIGHT = 0.1;

/** Floor shadow of the boombox: half its world width, centred under it (boombox spec §2.1). */
const BOOMBOX_SHADOW_RADIUS = (HELD_TEXEL * BOOMBOX_SPRITE.w * AVATAR_RADIUS) / 2;
const BOOMBOX_SHADOW_OFFSET = BOOMBOX_LEFT * AVATAR_RADIUS + BOOMBOX_SHADOW_RADIUS;

export interface Sprite {
  /** Whose disc this is: the key its facts are written under. */
  key: string;
  x: number;
  y: number;
  /** Packed like rgb(). */
  color: number;
  /** FACE_SIZE² texels shown inside the ring, or null for a flat disc. */
  face: Uint32Array | null;
  /** 0..1: brightens the ring while the person talks. */
  speaking: number;
  /** 0..1: walking bob, lifts the disc (its shadow stays on the floor). */
  bob: number;
  /** 0..1: walking bob of the held item, which trails the disc's. */
  itemBob: number;
  /** 0..1: sip progress, from resting in front of the body (0) to at the mouth (1). */
  sip: number;
  /** 0..1: cheers lift, from resting (0) to raised over the head (1); never above 0 together with `sip`. */
  cheers: number;
  /** −1..1: the raised drink's side-to-side wobble, already scaled by the lift. */
  wobble: number;
  /** Drawn in a hand on the viewer's right of the disc. */
  held: HeldItem | null;
  /** A boombox carried in a hand on the viewer's left of the disc (boombox spec §2.1). */
  boombox: boolean;
}

/** Who and what renderSprites draws in the room, seen from `eye`. */
export interface PeopleAndObjects {
  eye: PlayerState;
  people: readonly Sprite[];
  /** Voxel objects (the robot vacuum), drawn among the people. */
  objects: readonly VoxelInstance[];
  /** null draws the objects unlit. */
  lighting: Lighting | null;
}

export interface Projection {
  /** Internal-resolution pixels. */
  screenX: number;
  depth: number;
  /** Diameter in internal-resolution pixels. */
  size: number;
}

/** A soft round shadow on the floor, `depth` tiles ahead of the eye. */
interface FloorShadow {
  x: number;
  y: number;
  depth: number;
  /** Tiles. */
  radius: number;
  /** 0..1 of a full shadow. */
  strength: number;
}

/** Mixes a packed colour toward white by k (0..1), keeping alpha. */
export function mixWhite(c: number, k: number): number {
  const mix = (v: number) => (v + (255 - v) * k) | 0;
  const r = mix(c & 0xff);
  const g = mix((c >>> 8) & 0xff);
  const b = mix((c >>> 16) & 0xff);
  return ((c & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
}

export function hexToRgb(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

/** Ring colours parsed so far: a room has a handful, and each is drawn every frame. */
const ringColours = new Map<string, number>();

/** hexToRgb for a ring colour, parsed once and then remembered. */
export function ringRgb(hex: string): number {
  let c = ringColours.get(hex);
  if (c === undefined) {
    c = hexToRgb(hex);
    ringColours.set(hex, c);
  }
  return c;
}

/** Where (x, y) shows through `view`, matching renderWalls. Returns false when behind the camera. */
export function projectSprite(view: View, x: number, y: number, out: Projection): boolean {
  const { dirX, dirY, planeX, planeY, invDet } = view;
  const sx = x - view.x;
  const sy = y - view.y;
  const lateral = invDet * (dirY * sx - dirX * sy);
  const depth = invDet * (-planeY * sx + planeX * sy);
  if (depth < MIN_DEPTH) {
    return false;
  }
  out.screenX = view.halfWidth * (1 + lateral / depth);
  out.depth = depth;
  out.size = (2 * AVATAR_RADIUS * view.proj) / depth;
  return true;
}

/** The camera for the frame renderSprites is drawing, handed to every stage. */
const frameView = createView();
const projections: Projection[] = [];
/** People in front of the camera, far to near. */
const visible: number[] = [];
// The depth sorts return Math.sign: sort can't inline its comparator, and a small integer isn't boxed as a double is.
const spritesFarFirst = (a: number, b: number) =>
  Math.sign((projections[b] as Projection).depth - (projections[a] as Projection).depth);
/** Objects in front of the camera, far to near, with their centre depths. */
const voxelOrder: number[] = [];
const voxelDepths: number[] = [];
const voxelsFarFirst = (a: number, b: number) => Math.sign((voxelDepths[b] as number) - (voxelDepths[a] as number));
/** Each person's facts object for this frame (null without a facts map). */
const spriteFacts: (PeerFacts | null)[] = [];
/** Per column, the tallest disc slice (half-height, px) already counted this frame, nearest disc first. */
let cover = new Float64Array(0);
/** The shadow being drawn, filled by shadowUnder and shadowBeside. */
const shadow: FloorShadow = { x: 0, y: 0, depth: 0, radius: 0, strength: 0 };

/**
 * Draws the people's discs, and the objects interleaved with them far to near. With `facts`, also writes, per sprite
 * key, how many of its disc's columns are seen (in front of the walls and not hidden behind a nearer disc) and the
 * disc's diameter (both 0 when not drawn); every key in the map is zeroed first, and objects are reused.
 */
export function renderSprites(fb: Framebuffer, scene: PeopleAndObjects, facts?: Map<string, PeerFacts>): void {
  const view = setView(frameView, fb, scene.eye);
  bindFacts(scene.people, facts);
  projectVisible(view, scene.people);
  if (facts) {
    countSeenColumns(fb);
  }
  orderVoxels(view, scene.objects);
  // Shadows lie on the floor, so every disc and object (drawn next) covers every shadow.
  drawVoxelShadows(fb, view, scene.objects);
  drawSpriteShadows(fb, view, scene.people);
  drawFarToNear(fb, view, scene);
}

/** Zeroes every entry in `facts`, then points spriteFacts at each sprite's, adding the missing ones. */
function bindFacts(sprites: readonly Sprite[], facts: Map<string, PeerFacts> | undefined): void {
  facts?.forEach(zeroFacts);
  spriteFacts.length = sprites.length;
  for (let i = 0; i < sprites.length; i++) {
    const { key } = sprites[i] as Sprite;
    let f = facts?.get(key) ?? null;
    if (facts && !f) {
      f = { drawnColumns: 0, projectedSize: 0 };
      facts.set(key, f);
    }
    spriteFacts[i] = f;
  }
}

function zeroFacts(f: PeerFacts): void {
  f.drawnColumns = 0;
  f.projectedSize = 0;
}

/** Projects every sprite into `projections` and lists those in front of the camera in `visible`, far to near. */
function projectVisible(view: View, sprites: readonly Sprite[]): void {
  visible.length = 0;
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i] as Sprite;
    projections[i] ??= { screenX: 0, depth: 0, size: 0 };
    if (projectSprite(view, s.x, s.y, projections[i] as Projection)) {
      visible.push(i);
    }
  }
  visible.sort(spritesFarFirst);
}

/**
 * Facts for dynamic subscription (6c): walks `visible` nearest first. Every disc is centred on the eye line, so a
 * column of a farther disc is hidden when a nearer disc's slice in that column is at least as tall; the walking bob
 * is ignored. Only touches each disc's columns once and allocates only when the frame width changes.
 */
function countSeenColumns(fb: Framebuffer): void {
  const { width: w, zbuffer } = fb;
  if (cover.length !== w) {
    cover = new Float64Array(w);
  } else {
    cover.fill(0);
  }
  for (let k = visible.length - 1; k >= 0; k--) {
    const i = visible[k] as number;
    const f = spriteFacts[i] as PeerFacts | null;
    if (!f) {
      continue;
    }
    const { screenX, depth, size } = projections[i] as Projection;
    f.projectedSize = size;
    const r = size / 2;
    const firstCol = Math.max(0, Math.floor(screenX - r));
    const lastCol = Math.min(w - 1, Math.ceil(screenX + r));
    for (let col = firstCol; col <= lastCol; col++) {
      if (depth >= (zbuffer[col] as number)) {
        continue;
      }
      const dx = col + 0.5 - screenX;
      if (dx * dx >= r * r) {
        continue;
      }
      const slice = Math.sqrt(r * r - dx * dx);
      if (slice > (cover[col] as number)) {
        f.drawnColumns++;
        cover[col] = slice;
      }
    }
  }
}

/** Lists the objects in front of the camera in `voxelOrder`, far to near, with their depths in `voxelDepths`. */
function orderVoxels(view: View, voxels: readonly VoxelInstance[]): void {
  voxelOrder.length = 0;
  for (let i = 0; i < voxels.length; i++) {
    voxelDepths[i] = voxelDepth(view, voxels[i] as VoxelInstance);
    if ((voxelDepths[i] as number) > 0) {
      voxelOrder.push(i);
    }
  }
  voxelOrder.sort(voxelsFarFirst);
}

/** Each object's shadow, as wide as its footprint. */
function drawVoxelShadows(fb: Framebuffer, view: View, voxels: readonly VoxelInstance[]): void {
  for (const i of voxelOrder) {
    const v = voxels[i] as VoxelInstance;
    drawShadow(fb, view, shadowUnder(v.x, v.y, voxelDepths[i] as number, v.model.shadowRadius));
  }
}

/** Each visible avatar's shadow, and those of the drink and boombox it carries. */
function drawSpriteShadows(fb: Framebuffer, view: View, sprites: readonly Sprite[]): void {
  for (const i of visible) {
    const s = sprites[i] as Sprite;
    const { depth } = projections[i] as Projection;
    drawShadow(fb, view, shadowUnder(s.x, s.y, depth, SHADOW_RADIUS));
    if (s.held && drinkLift(s) < 1) {
      drawShadow(fb, view, drinkShadow(view, s, s.held, depth));
    }
    if (s.boombox) {
      drawShadow(fb, view, shadowBeside(view, s, BOOMBOX_SHADOW_OFFSET, BOOMBOX_SHADOW_RADIUS, depth));
    }
  }
}

/** How far the drink is raised, 0..1: to the mouth in a sip, over the head in a cheers. */
const drinkLift = (pose: HeldPose) => Math.max(pose.sip, pose.cheers);

/** Lifted to the mouth or over the head, the drink's shadow would sit on the disc's and double it, so it fades out. */
function drinkShadow(view: View, s: Sprite, drink: HeldItem, depth: number): FloorShadow {
  const radius = (HELD_TEXEL * HELD_SPRITES[drink].w * AVATAR_RADIUS) / 2;
  const offset = drinkLeft(drink, s) * AVATAR_RADIUS + radius;
  const beside = shadowBeside(view, s, offset, radius, depth);
  beside.strength = 1 - drinkLift(s);
  return beside;
}

/** The shadow, at full strength, under (x, y). Returns the reused `shadow`: draw it before the next call. */
function shadowUnder(x: number, y: number, depth: number, radius: number): FloorShadow {
  shadow.x = x;
  shadow.y = y;
  shadow.depth = depth;
  shadow.radius = radius;
  shadow.strength = 1;
  return shadow;
}

/**
 * The shadow of a thing carried `offset` tiles beside the disc along the camera plane (right on screen, left when
 * negative), so at the disc's depth. Returns the reused `shadow`, like shadowUnder.
 */
function shadowBeside(view: View, s: Sprite, offset: number, radius: number, depth: number): FloorShadow {
  return shadowUnder(s.x - view.dirY * offset, s.y + view.dirX * offset, depth, radius);
}

/** Darkens the floor under `shadow`: each pixel nearer than its wall is cast back to the floor point it shows. */
function drawShadow(fb: Framebuffer, view: View, { x: sx, y: sy, depth, radius, strength }: FloorShadow): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const { dirX, dirY, planeX, planeY, proj, half } = view;
  const nearest = Math.max(depth - radius, MIN_DEPTH);
  const eyeHeightPx = EYE_HEIGHT * proj;
  const firstRow = Math.max(Math.ceil(half), Math.floor(half + eyeHeightPx / (depth + radius)));
  const lastRow = Math.min(h - 1, Math.ceil(half + eyeHeightPx / nearest));
  const centreX = view.halfWidth * (1 + lateralOf(view, sx, sy) / depth);
  const halfWidthPx = (radius * proj) / nearest;
  const firstCol = Math.max(0, Math.floor(centreX - halfWidthPx));
  const lastCol = Math.min(w - 1, Math.ceil(centreX + halfWidthPx));
  const radius2 = radius * radius;
  // Row by row: the floor distance is the row's, so it's one division per row, not per pixel.
  for (let row = firstRow; row <= lastRow; row++) {
    const dist = eyeHeightPx / (row + 0.5 - half);
    for (let col = firstCol; col <= lastCol; col++) {
      if (dist >= (zbuffer[col] as number)) {
        continue;
      }
      const cameraX = (2 * col) / w - 1;
      const rayX = dirX + planeX * cameraX;
      const rayY = dirY + planeY * cameraX;
      const dx = shadowTexelCentre(view.x + rayX * dist - sx);
      const dy = shadowTexelCentre(view.y + rayY * dist - sy);
      const d2 = dx * dx + dy * dy;
      if (d2 >= radius2) {
        continue;
      }
      const band = Math.ceil((1 - d2 / radius2) * SHADOW_LEVELS) / SHADOW_LEVELS;
      const i = row * w + col;
      pixels[i] = scaleRgb(pixels[i] as number, 1 - SHADOW_DARKNESS * strength * band);
    }
  }
}

/** Where (x, y) lies across the camera plane, before dividing by its depth (see View.invDet). */
function lateralOf(view: View, x: number, y: number): number {
  return view.invDet * (view.dirY * (x - view.x) - view.dirX * (y - view.y));
}

/**
 * The centre of the shadow texel `offset` tiles from the shadow's centre, along x or y. The texel grid is centred on
 * the shadow, so it stays symmetric.
 */
const shadowTexelCentre = (offset: number) => (Math.floor(offset * SHADOW_TEXELS_PER_TILE) + 0.5) * SHADOW_TEXEL;

/** The visible avatars far to near, each object drawn just before the first avatar nearer than it. */
function drawFarToNear(fb: Framebuffer, view: View, scene: PeopleAndObjects): void {
  let nextVoxel = 0;
  for (const i of visible) {
    const projection = projections[i] as Projection;
    while (nextVoxel < voxelOrder.length && depthOfVoxel(nextVoxel) > projection.depth) {
      drawVoxel(fb, view, scene, nextVoxel++);
    }
    drawAvatar(fb, scene.people[i] as Sprite, projection);
  }
  while (nextVoxel < voxelOrder.length) {
    drawVoxel(fb, view, scene, nextVoxel++);
  }
}

/** The depth of the `k`th object in voxelOrder. */
const depthOfVoxel = (k: number) => voxelDepths[voxelOrder[k] as number] as number;

/** Draws the `k`th object in voxelOrder. */
function drawVoxel(fb: Framebuffer, view: View, { objects, lighting }: PeopleAndObjects, k: number): void {
  renderVoxel(fb, view, objects[voxelOrder[k] as number] as VoxelInstance, lighting);
}

/** One avatar: its disc, then the drink and boombox it carries in front of it. */
function drawAvatar(fb: Framebuffer, s: Sprite, projection: Projection): void {
  drawDisc(fb, s, projection);
  if (s.held) {
    drawDrink(fb, s, s.held, projection);
  }
  if (s.boombox) {
    drawBoombox(fb, s, projection);
  }
}

/** The disc, lifted by the walking bob and depth-tested per column: the face (or flat colour) inside the ring. */
function drawDisc(fb: Framebuffer, s: Sprite, { screenX, depth, size }: Projection): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const { color, face } = s;
  const faceSize = FACE_SIZE;
  const ring = ringColour(s);
  const r = size / 2;
  const r2 = r * r;
  const faceR2 = r2 * FACE_RADIUS * FACE_RADIUS;
  const faceR = r * FACE_RADIUS;
  const firstCol = Math.max(0, Math.floor(screenX - r));
  const lastCol = Math.min(w - 1, Math.ceil(screenX + r));
  const centreY = h / 2 - s.bob * BOB_HEIGHT * r;
  const firstRow = Math.max(0, Math.floor(centreY - r));
  const lastRow = Math.min(h - 1, Math.ceil(centreY + r));
  for (let col = firstCol; col <= lastCol; col++) {
    if (depth >= (zbuffer[col] as number)) {
      continue;
    }
    const dx = col + 0.5 - screenX;
    const dx2 = dx * dx;
    // Not mirrored: we face the person.
    const u = faceTexel(dx, faceR, faceSize);
    for (let row = firstRow; row <= lastRow; row++) {
      const dy = row + 0.5 - centreY;
      const d2 = dx2 + dy * dy;
      if (d2 > r2) {
        continue;
      }
      if (d2 > faceR2) {
        pixels[row * w + col] = ring;
      } else if (face) {
        pixels[row * w + col] = face[faceTexel(dy, faceR, faceSize) * faceSize + u] as number;
      } else {
        pixels[row * w + col] = color;
      }
    }
  }
}

/** The ring's colour: brightened while the person talks, and shaded on a flat disc. */
function ringColour({ color, face, speaking }: Sprite): number {
  const lit = speaking > 0 ? mixWhite(color, Math.min(speaking, 1) * SPEAKING_GLOW) : color;
  return face ? lit : scaleRgb(lit, FLAT_RING_SHADE);
}

/** The face texel column (or row) `offsetPx` from the disc's centre: the face's circle spans the whole texture. */
const faceTexel = (offsetPx: number, faceRadiusPx: number, faceSize: number) =>
  Math.min(faceSize - 1, Math.max(0, ((offsetPx / faceRadiusPx + 1) * 0.5 * faceSize) | 0));

/** The drink in the hand on the viewer's right, part way to the mouth or raised as `s` says, bobbing with the step. */
function drawDrink(fb: Framebuffer, s: Sprite, drink: HeldItem, { screenX, depth, size }: Projection): void {
  const r = size / 2;
  const left = screenX + drinkLeft(drink, s) * r;
  const top = fb.height / 2 - (drinkTop(drink, s) + s.itemBob * BOB_HEIGHT) * r;
  blitItem(fb, HELD_SPRITES[drink], left, top, HELD_TEXEL * r, depth);
}

/** The boombox in the hand on the viewer's left, bobbing with the step. */
function drawBoombox(fb: Framebuffer, s: Sprite, { screenX, depth, size }: Projection): void {
  const r = size / 2;
  const top = fb.height / 2 - (BOOMBOX_TOP + s.itemBob * BOB_HEIGHT) * r;
  blitItem(fb, BOOMBOX_SPRITE, screenX + BOOMBOX_LEFT * r, top, HELD_TEXEL * r, depth);
}

/** The drink's left edge in `pose`, in disc radii right of the disc's centre. */
const drinkLeft = (drink: HeldItem, pose: HeldPose) =>
  poseBlend(pose, HELD_LEFT, sipLeft(drink), CHEERS_LEFT) + CHEERS_WOBBLE * pose.wobble;
/** The drink's top in `pose`, in disc radii above the eye line. */
const drinkTop = (drink: HeldItem, pose: HeldPose) => poseBlend(pose, HELD_TOP, sipTop(drink), CHEERS_TOP);

/** Draws an item sprite with texel size t at (left, top), depth-tested per column like the disc. */
function blitItem(fb: Framebuffer, sprite: HeldSprite, left: number, top: number, t: number, depth: number): void {
  const { width: w, height: h, pixels, zbuffer } = fb;
  const { w: tw, h: th, texels } = sprite;
  const x0 = Math.max(0, Math.floor(left));
  const x1 = Math.min(w - 1, Math.ceil(left + tw * t) - 1);
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(h - 1, Math.ceil(top + th * t) - 1);
  for (let col = x0; col <= x1; col++) {
    if (depth >= (zbuffer[col] as number)) {
      continue;
    }
    const u = Math.floor((col + 0.5 - left) / t);
    if (u < 0 || u >= tw) {
      continue;
    }
    for (let row = y0; row <= y1; row++) {
      const v = Math.floor((row + 0.5 - top) / t);
      if (v < 0 || v >= th) {
        continue;
      }
      const c = texels[v * tw + u] as number;
      if (c !== 0) {
        pixels[row * w + col] = c;
      }
    }
  }
}
