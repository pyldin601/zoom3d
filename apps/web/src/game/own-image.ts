// The local player's own image through a portal window, with slow light (D41): the one rule every remote thing
// follows, for the own disc and scooter too. What it holds and does, its face, and its own motion's shift and turn are
// all as they were when the light the window shows left it.
import { type Apparent, type HeldItem, JUMP_TILES, type Point, type SnapshotBuffer } from '@zoom3d/shared';
import { createFaceHistory } from '../media/face-history';
import { FACE_SIZE } from '../media/faces';
import { sourceDoppler, terrellTurn } from '../renderer/slow-light-math';
import { shiftSteps } from '../renderer/spectrum';
import type { Sprite } from '../renderer/sprites';
import type { VoxelInstance } from '../renderer/voxels';
import { VELOCITY_WINDOW_MS } from './remote-world';
import { createStateRing } from './seen-state';

/** What the own disc shows besides where it is: its pose changes every frame of a sip, so the ring is long. */
interface OwnLook {
  held: HeldItem | null;
  boombox: boolean;
  sip: number;
  cheers: number;
  wobble: number;
  bob: number;
  itemBob: number;
  ride: number;
}

/** Eight seconds of frames at 60 Hz, the longest light time at the slowest c. */
const LOOK_CAPACITY = 512;

const LOOK_KEYS = ['held', 'boombox', 'sip', 'cheers', 'wobble', 'bob', 'itemBob', 'ride'] as const;

const sameLook = (a: OwnLook, b: OwnLook) =>
  a.held === b.held &&
  a.boombox === b.boombox &&
  a.sip === b.sip &&
  a.cheers === b.cheers &&
  a.wobble === b.wobble &&
  a.bob === b.bob &&
  a.itemBob === b.itemBob &&
  a.ride === b.ride;

export interface OwnImage {
  /** Notes the own disc as drawn now, before `see` takes it back in time. */
  record(now: number, self: Sprite): void;
  /**
   * Makes `self` (and the own `scooter`) look as they did `lateMs` before `now`, seen at `image` from `eye`: its look,
   * face, and its motion's shift and turn, its velocity from `trail`.
   */
  see(
    self: Sprite,
    scooter: VoxelInstance | null,
    trail: Pick<SnapshotBuffer, 'sample'>,
    image: Apparent,
    eye: Point,
    now: number,
    lateMs: number,
    lightSpeed: number
  ): void;
  clear(): void;
}

export function createOwnImage(): OwnImage {
  const looks = createStateRing<OwnLook>(
    LOOK_CAPACITY,
    () => ({ held: null, boombox: false, sip: 0, cheers: 0, wobble: 0, bob: 0, itemBob: 0, ride: 0 }),
    (from, to) => {
      Object.assign(to, from);
    },
    sameLook
  );
  const now = { held: null, boombox: false, sip: 0, cheers: 0, wobble: 0, bob: 0, itemBob: 0, ride: 0 } as OwnLook;
  const faces = createFaceHistory();
  const at = { x: 0, y: 0, angle: 0 };
  const before = { x: 0, y: 0, angle: 0 };
  return {
    record(t, self) {
      for (const key of LOOK_KEYS) {
        (now as unknown as Record<string, unknown>)[key] = self[key];
      }
      looks.push(t, now);
      if (self.face !== null && self.face.length === FACE_SIZE * FACE_SIZE) {
        faces.record(t, self.face);
      }
    },
    see(self, scooter, trail, image, eye, t, lateMs, lightSpeed) {
      const then = t - lateMs;
      Object.assign(self, looks.at(then));
      self.face = faces.at(then) ?? self.face;
      let vx = 0;
      let vy = 0;
      if (trail.sample(then, at) && trail.sample(then - VELOCITY_WINDOW_MS, before)) {
        const dx = at.x - before.x;
        const dy = at.y - before.y;
        if (Math.hypot(dx, dy) <= JUMP_TILES) {
          // Turned with the image, as the window shows it.
          vx = ((dx * image.cos - dy * image.sin) * 1000) / VELOCITY_WINDOW_MS;
          vy = ((dx * image.sin + dy * image.cos) * 1000) / VELOCITY_WINDOW_MS;
        }
      }
      const toEyeX = eye.x - image.x;
      const toEyeY = eye.y - image.y;
      const distance = Math.hypot(toEyeX, toEyeY);
      const nx = distance > 0 ? toEyeX / distance : 1;
      const ny = distance > 0 ? toEyeY / distance : 0;
      self.shift = shiftSteps(sourceDoppler(vx, vy, nx, ny, lightSpeed));
      if (scooter) {
        scooter.shift = self.shift;
        scooter.turn = terrellTurn(vx, vy, nx, ny, lightSpeed);
      }
    },
    clear() {
      looks.clear();
      faces.clear();
    },
  };
}
