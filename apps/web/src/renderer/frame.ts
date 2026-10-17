// One frame of the room, drawn back to front, then the HUD on its own canvas over it.
import type { GameMap, HeldItem, PlayerState } from '@zoom3d/shared';
import type { PeerFacts } from '../media/interest';
import { type AutomapPeer, drawAutomap } from './automap';
import type { Bob } from './bob';
import type { Framebuffer } from './framebuffer';
import { createAvatarGlows, type Glow, type GlowSource } from './glow';
import { drawLabels } from './labels';
import type { Lighting, ReflectionMode } from './lighting';
import { renderOwnBoombox } from './own-boombox';
import { renderOwnHeld } from './own-held';
import type { HeldPose } from './sip';
import { renderSprites, type Sprite } from './sprites';
import type { VoxelInstance } from './voxels';
import { renderWalls } from './walls';

/** Everything one frame shows. */
export interface RoomScene {
  map: GameMap;
  textures: Uint32Array[];
  eye: PlayerState;
  /** null draws the room unlit. */
  lighting: Lighting | null;
  reflections: ReflectionMode;
  people: readonly Sprite[];
  objects: readonly VoxelInstance[];
  /** Each person's name label and automap dot. */
  labels: readonly PersonLabel[];
  /** Your own face lights the room round you, as everyone's does; null until the room gives you a colour. */
  yourGlow: GlowSource | null;
  /** null while you aren't in the room (reconnecting). */
  inYourHands: InYourHands | null;
}

export type PersonLabel = AutomapPeer & { mic: boolean };

export interface InYourHands {
  drink: HeldItem | null;
  boombox: boolean;
  step: Pick<Bob, 'itemLift' | 'sway'>;
  gesture: HeldPose;
}

const avatarGlows = createAvatarGlows();

/** `seen` gets, per person, how much of them this frame drew (dynamic subscription reads it). */
export function renderView(fb: Framebuffer, scene: RoomScene, seen?: Map<string, PeerFacts>): void {
  const glows = avatarGlows.update(scene.people, scene.yourGlow);
  drawRoom(fb, scene, glows);
  drawPeopleAndObjects(fb, scene, seen);
  if (scene.inYourHands) {
    drawWhatYouHold(fb, scene.inYourHands);
  }
}

export function renderHud(hud: CanvasRenderingContext2D, fb: Framebuffer, scene: RoomScene, showMap: boolean): void {
  const { width, height } = hud.canvas;
  hud.clearRect(0, 0, width, height);
  drawLabels(hud, fb, scene.eye, scene.labels, width, height);
  if (showMap) {
    drawAutomap(hud, scene.map, scene.eye, width, height, scene.labels);
  }
}

function drawRoom(fb: Framebuffer, scene: RoomScene, glows: readonly Glow[]): void {
  renderWalls(fb, scene.map, scene.eye, scene.textures, scene.lighting, scene.reflections, glows);
}

function drawPeopleAndObjects(fb: Framebuffer, scene: RoomScene, seen: Map<string, PeerFacts> | undefined): void {
  renderSprites(fb, scene.eye, scene.people, seen, scene.objects, scene.lighting);
}

function drawWhatYouHold(fb: Framebuffer, hands: InYourHands): void {
  const { itemLift, sway } = hands.step;
  // The boombox first: a sip swings the drink across it, and the drink must stay in front.
  renderOwnBoombox(fb, hands.boombox, itemLift, sway);
  renderOwnHeld(fb, hands.drink, itemLift, sway, hands.gesture);
}
