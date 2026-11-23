import { type Apparent, SnapshotBuffer } from '@zoom3d/shared';
import { expect, test } from 'vitest';
import { FACE_SIZE } from '../media/faces';
import { SCOOTER_MODEL } from '../renderer/models/scooter';
import type { VoxelInstance } from '../renderer/voxels';
import { createOwnImage } from './own-image';
import { blankSprite } from './remote-world';

const self = () => ({ ...blankSprite('self'), face: new Uint32Array(FACE_SIZE * FACE_SIZE).fill(0xff000011) });
/** The own image, seen through a window, straight east of the eye and unturned. */
const image: Apparent = { x: 8, y: 2, sees: true, through: 1, cos: 1, sin: 0 };
const eye = { x: 2, y: 2 };

test('the own disc in a window shows what it held when its light left', () => {
  const own = createOwnImage();
  const disc = self();
  disc.held = 'beer';
  own.record(0, disc);
  disc.held = 'lighter';
  own.record(1000, disc);
  const trail = new SnapshotBuffer(8);
  trail.push({ t: 0, x: 3, y: 2, angle: 0 });
  own.see(disc, null, trail, image, eye, 1500, 800, 6);
  expect(disc.held).toBe('beer');
  disc.held = 'lighter';
  own.record(1600, disc);
  own.see(disc, null, trail, image, eye, 1600, 200, 6);
  expect(disc.held).toBe('lighter');
});

test('its face is the one it showed then, smaller', () => {
  const own = createOwnImage();
  const disc = self();
  own.record(0, disc);
  disc.face = new Uint32Array(FACE_SIZE * FACE_SIZE).fill(0xff000022);
  own.record(1000, disc);
  own.see(disc, null, new SnapshotBuffer(4), image, eye, 1500, 800, 6);
  expect(disc.face?.length).toBe(128 * 128);
  expect(disc.face?.at(0)).toBe(0xff000011);
});

test('walking toward where its image looks back at the eye, it is shifted up; its scooter is turned', () => {
  const own = createOwnImage();
  const disc = self();
  own.record(0, disc);
  // Moving west at 3 tiles/s: toward the eye from the image east of it.
  const trail = new SnapshotBuffer(64);
  for (let t = 0; t <= 2000; t += 66) {
    trail.push({ t, x: 10 - (3 * t) / 1000, y: 3, angle: Math.PI });
  }
  const scooter: VoxelInstance = { model: SCOOTER_MODEL, x: 0, y: 0, angle: Math.PI, lift: 0 };
  own.see(disc, scooter, trail, image, eye, 2000, 500, 6);
  expect(disc.shift).toBeGreaterThan(0);
  expect(scooter.shift).toBeGreaterThan(0);
  const crossing: Apparent = { ...image, x: 6, y: 8 };
  own.see(disc, scooter, trail, crossing, eye, 2000, 500, 6);
  expect(scooter.turn).not.toBe(0);
});
