// You, the local player: where you stand and how you step, the drink and boombox in your hands, your sip or cheers,
// and your face's glow. The camera is you, so you're drawn only as your glow and what you hold.
import { type GameMap, type HeldItem, type MoveInput, type PlayerState, spawnPoint, stepPlayer } from '@zoom3d/shared';
import { type Bob, createBob } from '../renderer/bob';
import type { InYourHands } from '../renderer/frame';
import type { GlowSource } from '../renderer/glow';
import { createGestureClock, type GestureClock } from '../renderer/sip';
import { ringRgb } from '../renderer/sprites';

export interface You {
  readonly player: PlayerState;
  readonly step: Bob;
  /** Your sip or cheers, on the performance.now() clock (held items spec §2.3–2.4). */
  readonly gesture: GestureClock;
  readonly drink: HeldItem | null;
  boombox: boolean;
  /** Null puts the drink down, ending any gesture. False when that drink was already in hand. */
  takeDrink(item: HeldItem | null): boolean;
  walk(map: GameMap, move: MoveInput, turnRad: number, dt: number): void;
  /** Your camera picture's average colour at `now`, or null while the camera is off. */
  useCameraColour(colourAt: (now: number) => number | null): void;
  /** In your camera's colour, else your ring's; null until the room gives you a ring colour. */
  glow(now: number, ringColour: string | null): GlowSource | null;
  hands(now: number): InYourHands;
}

export function createYou(map: GameMap, random: () => number): You {
  const player = spawnPoint(map, random);
  const step = createBob();
  const gesture = createGestureClock();
  let drink: HeldItem | null = null;
  let cameraColour: (now: number) => number | null = () => null;
  const glowSource = { x: 0, y: 0, face: null, color: 0 };
  const hands: InYourHands = { drink: null, boombox: false, step, gesture: gesture.pose(0) };

  const you: You = {
    player,
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
    walk(map, move, turnRad, dt) {
      player.angle += turnRad;
      stepPlayer(map, player, move, dt, player);
      step.update(player.x, player.y, dt);
    },
    useCameraColour(colourAt) {
      cameraColour = colourAt;
    },
    glow(now, ringColour) {
      if (!ringColour) {
        return null;
      }
      glowSource.x = player.x;
      glowSource.y = player.y;
      glowSource.color = cameraColour(now) ?? ringRgb(ringColour);
      return glowSource;
    },
    hands(now) {
      hands.drink = drink;
      hands.boombox = you.boombox;
      hands.gesture = gesture.pose(now);
      return hands;
    },
  };
  return you;
}
