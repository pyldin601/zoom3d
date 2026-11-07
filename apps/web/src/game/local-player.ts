// The local player: where they stand and how they step, what they hold and their boombox, their sip or cheers,
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
import { SCOOTER_DECK_TILES, SCOOTER_MODEL } from '../renderer/models/scooter';
import { createGestureClock, type GestureClock } from '../renderer/sip';
import { ringRgb, type Sprite } from '../renderer/sprites';
import type { VoxelInstance } from '../renderer/voxels';
import { blankSprite } from './remote-world';
import { createRideState, type RideState, stepRide } from './scooter-physics';

/** The first-person handlebar follows the steering keys this smoothly (time constant). */
const STEER_EASE_S = 0.1;

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
  readonly held: HeldItem | null;
  boombox: boolean;
  /** On a scooter, as the session says: the room loop sets it every frame. Stepping on starts the ride at rest. */
  riding: boolean;
  /** The scooter's motion while riding (scooter-physics.ts). */
  readonly ride: RideState;
  /** Takes `item` in hand, or empties it with null; anything but a drink ends any gesture. False if already held. */
  hold(item: HeldItem | null): boolean;
  /**
   * With `portals` (the room's, while on) a step through a doorway comes out of its destination, turned with it.
   * Riding, the scooter's physics moves the player instead of their feet.
   */
  walk(map: GameMap, move: MoveInput, turnRad: number, dt: number, portals?: Portals | null): void;
  /** The camera picture's average colour at `now`, or null while the camera is off. */
  useCameraColour(colourAt: (now: number) => number | null): void;
  useCameraFace(camera: OwnCamera): void;
  /** Built once for the ring colour the room gives the player. */
  useFallbackFace(faceFor: (ringColour: string) => FallbackFace): void;
  /** In the camera's colour, else the ring's; null until the room gives the player a ring colour. */
  glow(now: number, ringColour: string | null): GlowSource | null;
  /** The lighter in hand as a light, where the player stands; null while they hold anything else. */
  lighter(): LighterSource | null;
  /**
   * The own disc as others see it, with the fallback face while the camera is off; null until the room gives a ring
   * colour. The camera's face is read again only when `faceShown` (a window drew the disc last frame), else the last
   * one is kept.
   */
  avatar(now: number, ringColour: string | null, faceShown: boolean): Sprite | null;
  /** The ridden scooter under the own disc, for the windows that draw it; null on foot. */
  scooter(): VoxelInstance | null;
  firstPerson(now: number): FirstPerson;
}

export function createLocalPlayer(map: GameMap, random: () => number): LocalPlayer {
  const pose = spawnPoint(map, random);
  const step = createBob();
  const gesture = createGestureClock();
  let heldItem: HeldItem | null = null;
  let cameraColour: (now: number) => number | null = () => null;
  let camera: OwnCamera = { on: () => false, texels: () => null };
  let fallbackFor: (ringColour: string) => FallbackFace | null = () => null;
  let fallback: FallbackFace | null = null;
  let fallbackColour: string | null = null;
  const glowSource = { x: 0, y: 0, face: null, color: 0 };
  const lighterSource = { key: OWN_SPRITE_KEY, x: 0, y: 0 };
  // The room measures no level of the own mic, so the own ring never brightens: `speaking` stays 0.
  const ownDisc = blankSprite(OWN_SPRITE_KEY);
  let riding = false;
  const ride = createRideState();
  /** −1..1, eased toward the steering keys: how far the first-person handlebar is turned. */
  let steer = 0;
  const ownScooter: VoxelInstance = { model: SCOOTER_MODEL, x: 0, y: 0, angle: 0, lift: 0 };
  const firstPersonView: FirstPerson = {
    held: null,
    boombox: false,
    riding: false,
    steer: 0,
    step,
    gesture: gesture.pose(0),
  };

  const localPlayer: LocalPlayer = {
    pose,
    step,
    gesture,
    get held() {
      return heldItem;
    },
    boombox: false,
    get riding() {
      return riding;
    },
    set riding(on) {
      if (on && !riding) {
        ride.speed = 0;
        // Both hands go to the handlebar.
        gesture.cancel();
      }
      riding = on;
    },
    ride,
    hold(item) {
      if (item === heldItem) {
        return false;
      }
      heldItem = item;
      if (!isDrink(item)) {
        gesture.cancel();
      }
      return true;
    },
    walk(map, move, turnRad, dt, portals = null) {
      pose.angle += turnRad;
      if (riding) {
        stepRide(map, pose, ride, move, dt, portals);
        const target = Math.min(1, Math.max(-1, move.turn + move.strafe));
        steer += (target - steer) * (1 - Math.exp(-Math.max(dt, 0) / STEER_EASE_S));
      } else {
        steer = 0;
        stepPlayer(map, pose, move, dt, pose, portals);
      }
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
      if (heldItem !== 'lighter' || riding) {
        return null;
      }
      lighterSource.x = pose.x;
      lighterSource.y = pose.y;
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
      ownDisc.bob = localPlayer.riding ? 0 : step.lift;
      ownDisc.itemBob = localPlayer.riding ? 0 : step.itemLift;
      ownDisc.ride = localPlayer.riding ? SCOOTER_DECK_TILES : 0;
      const { sip, cheers, wobble } = gesture.pose(now);
      ownDisc.sip = sip;
      ownDisc.cheers = cheers;
      ownDisc.wobble = wobble;
      ownDisc.held = riding ? null : heldItem;
      ownDisc.boombox = riding ? false : localPlayer.boombox;
      return ownDisc;
    },
    scooter() {
      if (!localPlayer.riding) {
        return null;
      }
      ownScooter.x = pose.x;
      ownScooter.y = pose.y;
      ownScooter.angle = pose.angle;
      return ownScooter;
    },
    firstPerson(now) {
      firstPersonView.held = riding ? null : heldItem;
      firstPersonView.boombox = riding ? false : localPlayer.boombox;
      firstPersonView.riding = riding;
      firstPersonView.steer = steer;
      firstPersonView.gesture = gesture.pose(now);
      return firstPersonView;
    },
  };
  return localPlayer;
}
