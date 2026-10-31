// The local player: where they stand and how they step, the drink and boombox in their hands, their sip or cheers,
// and their face's glow. The camera is the local player, so they're drawn only as their glow and what they hold, and
// as their own disc where a portal's window looks back at them.
import {
  type GameMap,
  type HeldItem,
  isDrink,
  type MoveInput,
  type PlayerState,
  type Portals,
  spawnPoint,
  stepPlayer,
} from '@zoom3d/shared';
import { type Bob, createBob } from '../renderer/bob';
import type { FirstPerson } from '../renderer/frame';
import type { GlowSource } from '../renderer/glow';
import type { LighterSource } from '../renderer/lighter';
import { createGestureClock, type GestureClock } from '../renderer/sip';
import { ringRgb, type Sprite } from '../renderer/sprites';
import { blankSprite } from './remote-world';

/** The own disc's key: no peer has it, so it never reaches the facts dynamic subscription reads. */
export const OWN_SPRITE_KEY = 'self';

export interface OwnCamera {
  on(): boolean;
  /** The framed camera picture's texels at `now`, or null when it can't be read. A GPU readback. */
  texels(now: number): Uint32Array | null;
}

/** The face others see while the camera is off: the avatar picture, or else the initials disc. */
export interface FallbackFace {
  readonly texels: Uint32Array;
}

export interface LocalPlayer {
  /** Mutated in place by walking, the spawn and the server's corrections. */
  readonly pose: PlayerState;
  readonly step: Bob;
  /** The sip or cheers, on the performance.now() clock (held items spec §2.3–2.4). */
  readonly gesture: GestureClock;
  readonly drink: HeldItem | null;
  boombox: boolean;
  /** Null puts the drink down and the lighter takes its place, both ending any gesture. False when already in hand. */
  takeDrink(item: HeldItem | null): boolean;
  /** With `portals` (the room's, while on) a step through a doorway comes out of its destination, turned with it. */
  walk(map: GameMap, move: MoveInput, turnRad: number, dt: number, portals?: Portals | null): void;
  /** The camera picture's average colour at `now`, or null while the camera is off. */
  useCameraColour(colourAt: (now: number) => number | null): void;
  useCameraFace(camera: OwnCamera): void;
  /** Built once for the ring colour the room gives the player. */
  useFallbackFace(faceFor: (ringColour: string) => FallbackFace): void;
  /** In the camera's colour, else the ring's; null until the room gives the player a ring colour. */
  glow(now: number, ringColour: string | null): GlowSource | null;
  /** The lighter in hand as a light, where the player stands and faces; null while they hold anything else. */
  lighter(): LighterSource | null;
  /**
   * The own disc as others see it, with the fallback face while the camera is off; null until the room gives a ring
   * colour. The camera's face is read again only when `faceShown` (a window drew the disc last frame), else the last
   * one is kept.
   */
  avatar(now: number, ringColour: string | null, faceShown: boolean): Sprite | null;
  firstPerson(now: number): FirstPerson;
}

export function createLocalPlayer(map: GameMap, random: () => number): LocalPlayer {
  const pose = spawnPoint(map, random);
  const step = createBob();
  const gesture = createGestureClock();
  let drink: HeldItem | null = null;
  let cameraColour: (now: number) => number | null = () => null;
  let camera: OwnCamera = { on: () => false, texels: () => null };
  let fallbackFor: (ringColour: string) => FallbackFace | null = () => null;
  let fallback: FallbackFace | null = null;
  let fallbackColour: string | null = null;
  const glowSource = { x: 0, y: 0, face: null, color: 0 };
  const lighterSource = { key: OWN_SPRITE_KEY, x: 0, y: 0, angle: 0 };
  // The room measures no level of the own mic, so the own ring never brightens: `speaking` stays 0.
  const ownDisc = blankSprite(OWN_SPRITE_KEY);
  const held: FirstPerson = { drink: null, boombox: false, step, gesture: gesture.pose(0) };

  const localPlayer: LocalPlayer = {
    pose,
    step,
    gesture,
    get drink() {
      return drink;
    },
    boombox: false,
    takeDrink(item) {
      if (item === drink) {
        return false;
      }
      drink = item;
      if (!isDrink(item)) {
        gesture.cancel();
      }
      return true;
    },
    walk(map, move, turnRad, dt, portals = null) {
      pose.angle += turnRad;
      stepPlayer(map, pose, move, dt, pose, portals);
      step.update(pose.x, pose.y, dt);
    },
    useCameraColour(colourAt) {
      cameraColour = colourAt;
    },
    useCameraFace(own) {
      camera = own;
    },
    useFallbackFace(faceFor) {
      fallbackFor = faceFor;
      fallbackColour = null;
    },
    glow(now, ringColour) {
      if (!ringColour) {
        return null;
      }
      glowSource.x = pose.x;
      glowSource.y = pose.y;
      glowSource.color = cameraColour(now) ?? ringRgb(ringColour);
      return glowSource;
    },
    lighter() {
      if (drink !== 'lighter') {
        return null;
      }
      lighterSource.x = pose.x;
      lighterSource.y = pose.y;
      lighterSource.angle = pose.angle;
      return lighterSource;
    },
    avatar(now, ringColour, faceShown) {
      if (!ringColour) {
        return null;
      }
      ownDisc.x = pose.x;
      ownDisc.y = pose.y;
      ownDisc.color = ringRgb(ringColour);
      if (fallbackColour !== ringColour) {
        fallbackColour = ringColour;
        fallback = fallbackFor(ringColour);
      }
      const fallbackTexels = fallback?.texels ?? null;
      // The camera is asked every frame, so a camera turned off while the disc was hidden never comes back live.
      if (!camera.on()) {
        ownDisc.face = fallbackTexels;
      } else if (faceShown) {
        ownDisc.face = camera.texels(now) ?? fallbackTexels;
      } else {
        // Before the first read: a window's first frame of the disc comes before it is reported shown.
        ownDisc.face ??= fallbackTexels;
      }
      ownDisc.bob = step.lift;
      ownDisc.itemBob = step.itemLift;
      const { sip, cheers, wobble } = gesture.pose(now);
      ownDisc.sip = sip;
      ownDisc.cheers = cheers;
      ownDisc.wobble = wobble;
      ownDisc.held = drink;
      ownDisc.boombox = localPlayer.boombox;
      return ownDisc;
    },
    firstPerson(now) {
      held.drink = drink;
      held.boombox = localPlayer.boombox;
      held.gesture = gesture.pose(now);
      return held;
    },
  };
  return localPlayer;
}
