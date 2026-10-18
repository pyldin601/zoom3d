// One frame of the room, drawn back to front, then the HUD on its own canvas over it.
import type { HeldItem } from '@zoom3d/shared';
import type { PeerFacts } from '../media/interest';
import { type AutomapPeer, drawAutomap } from './automap';
import type { Framebuffer } from './framebuffer';
import { createAvatarGlows, type Glow, type GlowSource } from './glow';
import { drawLabels } from './labels';
import type { ReflectionMode } from './lighting';
import { renderOwnBoombox } from './own-boombox';
import { type HeldStep, renderOwnHeld } from './own-held';
import type { HeldPose } from './sip';
import { type PeopleAndObjects, renderSprites } from './sprites';
import { renderTraced, type TracedLighting } from './traced/frame';
import { tracedObjectLight } from './traced/objects';
import type { VoxelLight } from './voxels';
import { type Room, renderWalls } from './walls';

/** Everything one frame shows. */
export interface RoomScene extends Room, PeopleAndObjects {
  reflections: ReflectionMode;
  /** The baked rays' light; when set the room is drawn by `renderTraced`, else by `renderWalls` from `lighting`. */
  traced: TracedLighting | null;
  /** Each person's name label and automap dot. */
  labels: readonly PersonLabel[];
  /** The local player's own face lights the room round them, as everyone's does; null until they have a colour. */
  ownGlow: GlowSource | null;
  /** What the local player holds; null while they aren't in the room (reconnecting). */
  firstPerson: FirstPerson | null;
}

export type PersonLabel = AutomapPeer & { mic: boolean };

export interface FirstPerson {
  drink: HeldItem | null;
  boombox: boolean;
  step: HeldStep;
  gesture: HeldPose;
}

const avatarGlows = createAvatarGlows();
/** Each TracedLighting's light on objects, made once: it owns scratch space that a frame would otherwise allocate. */
const objectLights = new WeakMap<TracedLighting, VoxelLight>();

/** `seen` gets, per person, how much of them this frame drew (dynamic subscription reads it). */
export function renderView(fb: Framebuffer, scene: RoomScene, seen?: Map<string, PeerFacts>): void {
  const glows = avatarGlows.update(scene.people, scene.ownGlow);
  drawRoom(fb, scene, glows);
  drawPeopleAndObjects(fb, scene, seen);
  if (scene.firstPerson) {
    drawFirstPerson(fb, scene.firstPerson);
  }
}

export function renderHud(hud: CanvasRenderingContext2D, fb: Framebuffer, scene: RoomScene, showMap: boolean): void {
  const { width, height } = hud.canvas;
  hud.clearRect(0, 0, width, height);
  drawLabels(hud, fb, scene.eye, scene.labels);
  if (showMap) {
    drawAutomap(hud, scene.map, scene.eye, scene.labels);
  }
}

function drawRoom(fb: Framebuffer, scene: RoomScene, glows: readonly Glow[]): void {
  if (isTraced(scene)) {
    renderTraced(fb, scene);
  } else {
    renderWalls(fb, scene, glows);
  }
}

function isTraced(scene: RoomScene): scene is RoomScene & { traced: TracedLighting } {
  return scene.traced !== null;
}

function drawPeopleAndObjects(fb: Framebuffer, scene: RoomScene, seen: Map<string, PeerFacts> | undefined): void {
  // Set every frame: a scene that was traced and is not now must not keep the light of the room it left.
  scene.objectLight = isTraced(scene) ? objectLightOf(scene.traced) : null;
  renderSprites(fb, scene, seen);
}

function objectLightOf(traced: TracedLighting): VoxelLight {
  let light = objectLights.get(traced);
  if (light === undefined) {
    light = tracedObjectLight(traced);
    objectLights.set(traced, light);
  }
  return light;
}

function drawFirstPerson(fb: Framebuffer, hands: FirstPerson): void {
  // The boombox first: a sip swings the drink across it, and the drink must stay in front.
  renderOwnBoombox(fb, hands.boombox, hands.step);
  renderOwnHeld(fb, hands.drink, hands.step, hands.gesture);
}
