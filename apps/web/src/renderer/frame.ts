// One frame of the room, drawn back to front, then the HUD on its own canvas over it. With portals on, each window is
// the room drawn again from the eye carried through its portal, for the window's columns (portal doorways spec §2.5).
import { applyAngle, applyPoint, type HeldItem, type PlayerState, type Portal } from '@zoom3d/shared';
import type { PeerFacts } from '../media/interest';
import { type AutomapPeer, drawAutomap } from './automap';
import { createView, type Pass, setView, WHOLE_FRAME, WINDOW_LEVELS } from './camera';
import { adaptEye, createExposure, type Eye, eyeGain, meterFrame } from './eye-adaptation';
import { createFramebuffer, type Framebuffer } from './framebuffer';
import { createAvatarGlows, createPortalGlows, type Glow, type GlowSource } from './glow';
import { drawLabels, type NameLabel } from './labels';
import { createLighterGlows, type LighterSource } from './lighter';
import type { ReflectionMode } from './lighting';
import { renderOwnBoombox } from './own-boombox';
import { type HeldStep, renderOwnHeld } from './own-held';
import { nextRippleDown, openingEdge, shimmerAndRim, startRippleDown, toSketchPx } from './portal-window';
import type { HeldPose } from './sip';
import { type PeopleAndObjects, renderSprites, type Sprite } from './sprites';
import { type Room, renderWalls, rowsCovered } from './walls';

/** What one pass draws: the room, its people and objects, from one eye, on the pass's columns. */
type PassScene = Omit<Room, 'objects' | 'people'> & PeopleAndObjects & PortalClock & { reflections: ReflectionMode };

/** One clock for the portals' glow and their windows' shimmer, so the two never drift apart. */
interface PortalClock {
  /** The portals' swell, 0..1 (game/portal-pulse.ts): their glow brightens with it. */
  portalPulse: number;
  /** The windows' shimmer rolls with this, s. */
  portalTime: number;
}

/** Everything one frame shows. */
export interface RoomScene extends PassScene {
  /** Each person's name label and automap dot. */
  labels: readonly PersonLabel[];
  /** The local player's own face lights the room round them, as everyone's does; null until they have a colour. */
  ownGlow: GlowSource | null;
  /** Everyone else holding a lighter: each throws its light ahead of them (lighter spec §3.2). */
  lighters: readonly LighterSource[];
  /** The local player's own lighter, when they hold one. */
  ownLighter: LighterSource | null;
  /** The lighters flicker with this, s. */
  lighterSeconds: number;
  /**
   * The local player's own disc, at their own spot: only windows draw it, as the eye stands there. Null with portals
   * off or out of the room.
   */
  self: Sprite | null;
  /** The own name label where a portal shows the own spot; null when none does, and always with `self` null. */
  ownLabel: NameLabel | null;
  /** What the local player holds; null while they aren't in the room (reconnecting). */
  firstPerson: FirstPerson | null;
  /** The frame's exposure follows the eye; null leaves the frame as drawn (an unlit room). */
  adaptation: EyeAdaptation | null;
}

export interface EyeAdaptation {
  eye: Eye;
  /** Real time since the last frame. */
  dtS: number;
  /** The eye's level stays as it is, and the frame is exposed by it: the portal blackout (D30) must stay dark. */
  frozen: boolean;
}

export type PersonLabel = AutomapPeer & NameLabel;

export interface FirstPerson {
  drink: HeldItem | null;
  boombox: boolean;
  step: HeldStep;
  gesture: HeldPose;
}

const avatarGlows = createAvatarGlows();
const portalGlows = createPortalGlows();
const lighterGlows = createLighterGlows();
const NO_GLOWS: readonly Glow[] = [];
/** The avatar glows, the lighters' then the portal glows, when portals are on: one list reused from frame to frame. */
const allGlows: Glow[] = [];
/** This frame's lighter glows: besides the room, they light the objects. */
let objectGlows: readonly Glow[] = [];
/** The scene's lighters, then the own one: one list reused from frame to frame. */
const lighterSources: LighterSource[] = [];

/** One level of windows: the frame they are drawn into, at the frame's size, and the scene they are drawn from. */
interface WindowLevel {
  fb: Framebuffer;
  scene: PassScene & { eye: PlayerState; pass: Pass };
}

/** Index 0 is level 1. */
const windowLevels: WindowLevel[] = [];
/** What the windows' passes drew of each person, added to `seen` after the frame's own pass zeroes and fills it. */
const seenThroughWindows = new Map<string, PeerFacts>();
/** The people every window draws: the scene's, then the local player's own disc. */
const windowPeople: Sprite[] = [];
let ownAvatarDrawn = false;
/** The own label, as the one-entry list drawLabels takes. */
const ownLabels: NameLabel[] = [];
const frameView = createView();
const exposure = createExposure();

/** `seen` gets, per person, how much of them this frame drew (dynamic subscription reads it). */
export function renderView(fb: Framebuffer, scene: RoomScene, seen?: Map<string, PeerFacts>): void {
  const glows = gatherGlows(scene);
  if (scene.portals) {
    fitWindowLevels(fb);
    seenThroughWindows.forEach(zeroFacts);
    listWindowPeople(scene.people, scene.self);
  }
  drawPass(fb, scene, glows, seen, 0);
  const windowsCounted = scene.portals !== null && seen !== undefined;
  if (windowsCounted) {
    seenThroughWindows.forEach(addToSeen, seen);
  }
  ownAvatarDrawn =
    windowsCounted && scene.self !== null && (seenThroughWindows.get(scene.self.key)?.drawnColumns ?? 0) > 0;
  if (scene.adaptation) {
    exposeToEye(fb, scene.adaptation);
  }
  if (scene.firstPerson) {
    drawFirstPerson(fb, scene.firstPerson);
  }
}

/**
 * Whether the last frame's windows drew any of the own disc: its face is worth reading back only then. Counted only
 * for a frame drawn with a `seen` map.
 */
export const ownAvatarShown = () => ownAvatarDrawn;

/** Copied every frame, as the scene's list can keep its length and change whose discs it holds. */
function listWindowPeople(people: readonly Sprite[], self: Sprite | null): void {
  let count = 0;
  for (const person of people) {
    windowPeople[count++] = person;
  }
  if (self) {
    windowPeople[count++] = self;
  }
  windowPeople.length = count;
}

/**
 * Everything that glows this frame: the avatars, the lighters (only in a lit room: their shadow tables cost) and,
 * with portals on, the doorways.
 */
function gatherGlows(scene: RoomScene): readonly Glow[] {
  let count = 0;
  for (const g of avatarGlows.update(scene.people, scene.ownGlow)) {
    allGlows[count++] = g;
  }
  objectGlows = scene.lighting
    ? lighterGlows.update(listLighters(scene), scene.map, scene.portals ?? null, scene.lighterSeconds)
    : NO_GLOWS;
  for (const g of objectGlows) {
    allGlows[count++] = g;
  }
  if (scene.portals) {
    for (const g of portalGlows.update(scene.portals, scene.portalPulse, scene.lighting?.portalGlowSeen ?? null)) {
      allGlows[count++] = g;
    }
  }
  allGlows.length = count;
  return allGlows;
}

function listLighters(scene: RoomScene): readonly LighterSource[] {
  let count = 0;
  for (const source of scene.lighters) {
    lighterSources[count++] = source;
  }
  if (scene.ownLighter) {
    lighterSources[count++] = scene.ownLighter;
  }
  lighterSources.length = count;
  return lighterSources;
}

/**
 * The room, its windows, then the people and objects in front of them: a window's rows are copied in before the
 * people are drawn over them. The window's depths go into the z-buffer last, as the people are clipped at its plane.
 */
function drawPass(
  fb: Framebuffer,
  scene: PassScene,
  glows: readonly Glow[],
  seen: Map<string, PeerFacts> | undefined,
  level: number
): void {
  drawRoom(fb, scene, glows);
  if (scene.portals) {
    drawWindows(fb, scene, glows, seen, level);
  }
  drawPeopleAndObjects(fb, scene, level === 0 ? seen : seen && seenThroughWindows);
  if (scene.portals) {
    takeDepthsBeyondWindows(fb, scene, level);
  }
}

/** Each run of columns showing one portal's window, drawn at the next level and copied in. */
function drawWindows(
  fb: Framebuffer,
  scene: PassScene,
  glows: readonly Glow[],
  seen: Map<string, PeerFacts> | undefined,
  level: number
): void {
  const { portalAt } = fb;
  const { fromCol, toCol } = passOf(scene);
  const endCol = Math.min(fb.width, toCol);
  let col = fromCol;
  while (col < endCol) {
    const portal = portalAt[col] as number;
    let runEnd = col + 1;
    while (runEnd < endCol && portalAt[runEnd] === portal) {
      runEnd++;
    }
    if (portal >= 0) {
      drawWindow(fb, scene, glows, seen, level, portal, col, runEnd);
    }
    col = runEnd;
  }
}

/** The window onto `portal` on columns [fromCol, toCol): the scene from the eye carried through it, past its plane. */
function drawWindow(
  fb: Framebuffer,
  scene: PassScene,
  glows: readonly Glow[],
  seen: Map<string, PeerFacts> | undefined,
  level: number,
  portal: number,
  fromCol: number,
  toCol: number
): void {
  const shown = scene.portals?.list.at(portal);
  const next = windowLevels.at(level);
  if (!shown || !next) {
    return;
  }
  const { toDest } = shown;
  const beyond = next.scene;
  applyPoint(toDest, scene.eye.x, scene.eye.y, beyond.eye);
  beyond.eye.angle = applyAngle(toDest, scene.eye.angle);
  beyond.pass.fromCol = fromCol;
  beyond.pass.toCol = toCol;
  beyond.pass.nearDepth = fb.zbuffer;
  beyond.pass.lastLevel = level + 1 === WINDOW_LEVELS;
  beyond.map = scene.map;
  beyond.textures = scene.textures;
  beyond.lighting = scene.lighting;
  beyond.reflections = scene.reflections;
  beyond.people = windowPeople;
  beyond.objects = scene.objects;
  beyond.portals = scene.portals;
  beyond.portalPulse = scene.portalPulse;
  beyond.portalTime = scene.portalTime;
  drawPass(next.fb, beyond, glows, seen, level + 1);
  copyWindowRows(next.fb, fb, scene, shown, fromCol, toCol);
}

/**
 * Copies each column's window rows, those a wall at its plane would cover, from `from` into `to`, shimmering them
 * and lighting the opening's rim.
 */
function copyWindowRows(
  from: Framebuffer,
  to: Framebuffer,
  scene: PassScene,
  portal: Portal,
  fromCol: number,
  toCol: number
): void {
  const { width: w, height: h, zbuffer } = to;
  const { portalPulse: pulse, portalTime: seconds } = scene;
  const view = setView(frameView, to, scene.eye);
  for (let col = fromCol; col < toCol; col++) {
    const depth = zbuffer[col] as number;
    const openingPx = view.proj / depth;
    // The opening's top and bottom, unclamped: close to the plane they lie off the frame, and so does the rim.
    const openingTop = view.half - openingPx / 2;
    const openingBottom = view.half + openingPx / 2;
    const { start, end } = rowsCovered(h, openingPx);
    const sideEdge = openingEdge(view, portal, col, depth, w);
    startRippleDown(start, col, w, seconds);
    for (let row = start; row < end; row++) {
      const rowCentre = row + 0.5;
      const topOrBottomEdge = toSketchPx(Math.min(rowCentre - openingTop, openingBottom - rowCentre), w);
      const edge = Math.max(0, Math.min(sideEdge, topOrBottomEdge));
      to.pixels[row * w + col] = shimmerAndRim(from.pixels[row * w + col] as number, pulse, nextRippleDown(), edge);
    }
  }
}

/** The depths seen through each window replace its plane's in the z-buffer, so labels hide behind what it shows. */
function takeDepthsBeyondWindows(fb: Framebuffer, scene: PassScene, level: number): void {
  const beyond = windowLevels.at(level)?.fb;
  if (!beyond) {
    return;
  }
  const { fromCol, toCol } = passOf(scene);
  for (let col = fromCol; col < Math.min(fb.width, toCol); col++) {
    if ((fb.portalAt[col] as number) >= 0) {
      fb.zbuffer[col] = beyond.zbuffer[col] as number;
    }
  }
}

const passOf = (scene: PassScene) => scene.pass ?? WHOLE_FRAME;

/** Makes the windows' frames match `fb`'s size and FOV: they are rebuilt only when it changes. */
function fitWindowLevels(fb: Framebuffer): void {
  for (let i = 0; i < WINDOW_LEVELS; i++) {
    const level = windowLevels.at(i);
    if (level && level.fb.width === fb.width && level.fb.height === fb.height && level.fb.fov === fb.fov) {
      continue;
    }
    windowLevels[i] = {
      fb: createFramebuffer(fb.width, fb.height, fb.fov),
      scene: {
        map: { width: 0, height: 0, tiles: new Uint8Array(0), spawn: { x: 0, y: 0 } },
        textures: [],
        eye: { x: 0, y: 0, angle: 0 },
        lighting: null,
        reflections: 'none',
        portalPulse: 1,
        portalTime: 0,
        people: [],
        objects: [],
        portals: null,
        pass: { fromCol: 0, toCol: 0, nearDepth: null, lastLevel: false },
      },
    };
  }
}

function zeroFacts(f: PeerFacts): void {
  f.drawnColumns = 0;
  f.projectedSize = 0;
}

/** Adds a window's facts to the frame's: its columns, and its size where the frame's own pass drew none of them. */
function addToSeen(this: Map<string, PeerFacts>, through: PeerFacts, key: string): void {
  const f = this.get(key);
  if (!f || through.drawnColumns === 0) {
    return;
  }
  f.projectedSize = f.drawnColumns === 0 ? through.projectedSize : Math.max(f.projectedSize, through.projectedSize);
  f.drawnColumns += through.drawnColumns;
}

export function renderHud(hud: CanvasRenderingContext2D, fb: Framebuffer, scene: RoomScene, showMap: boolean): void {
  const { width, height } = hud.canvas;
  hud.clearRect(0, 0, width, height);
  drawLabels(hud, fb, scene.eye, scene.labels);
  // Apart from `labels`, which the automap also reads: there the arrow is the local player.
  if (scene.ownLabel) {
    ownLabels[0] = scene.ownLabel;
    drawLabels(hud, fb, scene.eye, ownLabels);
  }
  if (showMap) {
    drawAutomap(hud, scene.map, scene.eye, scene.labels);
  }
}

function drawRoom(fb: Framebuffer, scene: PassScene, glows: readonly Glow[]): void {
  renderWalls(fb, scene, glows, objectGlows);
}

function drawPeopleAndObjects(fb: Framebuffer, scene: PassScene, seen: Map<string, PeerFacts> | undefined): void {
  renderSprites(fb, scene, seen, objectGlows);
}

/**
 * Meters the finished room, windows included, and exposes it by the eye's level (eye adaptation spec). The hands come
 * after: they are neither metered nor exposed.
 */
function exposeToEye(fb: Framebuffer, adaptation: EyeAdaptation): void {
  if (!adaptation.frozen) {
    adaptEye(adaptation.eye, meterFrame(fb), adaptation.dtS);
  }
  exposure.apply(fb, eyeGain(adaptation.eye.level));
}

function drawFirstPerson(fb: Framebuffer, hands: FirstPerson): void {
  // The boombox first: a sip swings the drink across it, and the drink must stay in front.
  renderOwnBoombox(fb, hands.boombox, hands.step);
  renderOwnHeld(fb, hands.drink, hands.step, hands.gesture);
}
