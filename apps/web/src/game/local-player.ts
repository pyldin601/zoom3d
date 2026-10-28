// The local player: where they stand and how they step, the drink and boombox in their hands, their sip or cheers,
// and their face's glow. The camera is the local player, so they're drawn only as their glow and what they hold.
import {
  type GameMap,
  type HeldItem,
  type MoveInput,
  type PlayerState,
  type Portals,
  spawnPoint,
  stepPlayer,
} from '@zoom3d/shared';
import { type Bob, createBob } from '../renderer/bob';
import type { FirstPerson } from '../renderer/frame';
import type { GlowSource } from '../renderer/glow';
import { createGestureClock, type GestureClock } from '../renderer/sip';
import { ringRgb } from '../renderer/sprites';

export interface LocalPlayer {
  /** Mutated in place by walking, the spawn and the server's corrections. */
  readonly pose: PlayerState;
  readonly step: Bob;
  /** The sip or cheers, on the performance.now() clock (held items spec §2.3–2.4). */
  readonly gesture: GestureClock;
  readonly drink: HeldItem | null;
  boombox: boolean;
  /** Null puts the drink down, ending any gesture. False when that drink was already in hand. */
  takeDrink(item: HeldItem | null): boolean;
  /** With `portals` (the room's, while on) a step through a doorway comes out of its destination, turned with it. */
  walk(map: GameMap, move: MoveInput, turnRad: number, dt: number, portals?: Portals | null): void;
  /** The camera picture's average colour at `now`, or null while the camera is off. */
  useCameraColour(colourAt: (now: number) => number | null): void;
  /** In the camera's colour, else the ring's; null until the room gives the player a ring colour. */
  glow(now: number, ringColour: string | null): GlowSource | null;
  firstPerson(now: number): FirstPerson;
}

export function createLocalPlayer(map: GameMap, random: () => number): LocalPlayer {
  const pose = spawnPoint(map, random);
  const step = createBob();
  const gesture = createGestureClock();
  let drink: HeldItem | null = null;
  let cameraColour: (now: number) => number | null = () => null;
  const glowSource = { x: 0, y: 0, face: null, color: 0 };
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
      if (item === null) {
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
    glow(now, ringColour) {
      if (!ringColour) {
        return null;
      }
      glowSource.x = pose.x;
      glowSource.y = pose.y;
      glowSource.color = cameraColour(now) ?? ringRgb(ringColour);
      return glowSource;
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
