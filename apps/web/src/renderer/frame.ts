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
import { type Room, renderWalls } from './walls';

/** Everything one frame shows. */
export interface RoomScene extends Room, PeopleAndObjects {
  reflections: ReflectionMode;
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
  step: HeldStep;
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
  drawLabels(hud, fb, scene.eye, scene.labels);
  if (showMap) {
    drawAutomap(hud, scene.map, scene.eye, scene.labels);
  }
}

function drawRoom(fb: Framebuffer, scene: RoomScene, glows: readonly Glow[]): void {
  renderWalls(fb, scene, glows);
}

function drawPeopleAndObjects(fb: Framebuffer, scene: RoomScene, seen: Map<string, PeerFacts> | undefined): void {
  renderSprites(fb, scene, seen);
}

function drawWhatYouHold(fb: Framebuffer, hands: InYourHands): void {
  // The boombox first: a sip swings the drink across it, and the drink must stay in front.
  renderOwnBoombox(fb, hands.boombox, hands.step);
  renderOwnHeld(fb, hands.drink, hands.step, hands.gesture);
}
