import { expect, test } from 'vitest';
import { createFaceHistory, FAR_FACE_SIZE, NEAR_FACE_SIZE } from './face-history';
import { FACE_SIZE } from './faces';

/** A FACE_SIZE² face of one colour. */
const flat = (colour: number) => new Uint32Array(FACE_SIZE * FACE_SIZE).fill(colour);

test('it gives the newest frame at or before a time, near frames at 128²', () => {
  const history = createFaceHistory();
  history.record(1000, flat(0xff000011));
  history.record(1033, flat(0xff000022));
  history.record(1066, flat(0xff000033));
  const seen = history.at(1050);
  expect(seen?.length).toBe(NEAR_FACE_SIZE * NEAR_FACE_SIZE);
  expect(seen?.at(0)).toBe(0xff000022);
  expect(history.at(5000)?.at(0)).toBe(0xff000033);
});

test('before the oldest frame it holds the oldest', () => {
  const history = createFaceHistory();
  history.record(1000, flat(0xff000011));
  history.record(1033, flat(0xff000022));
  expect(history.at(10)?.at(0)).toBe(0xff000011);
});

test('past the near ring it reads the far one, at 64²', () => {
  const history = createFaceHistory();
  for (let i = 0; i < 200; i++) {
    history.record(i * 33, flat(0xff000000 | i));
  }
  // The near ring keeps the last 32 frames: frame 40 is only in the far ring, every other frame.
  const seen = history.at(40 * 33);
  expect(seen?.length).toBe(FAR_FACE_SIZE * FAR_FACE_SIZE);
  expect([40, 39]).toContain((seen?.at(0) ?? 0) & 0xff);
});

test('where the camera was off it shows the fallback, and live again after', () => {
  const history = createFaceHistory();
  history.record(1000, flat(0xff000011));
  history.mark(1010, false);
  history.mark(2000, true);
  history.record(2010, flat(0xff000022));
  expect(history.at(1005)?.at(0)).toBe(0xff000011);
  expect(history.at(1500)).toBeNull();
  expect(history.at(2020)?.at(0)).toBe(0xff000022);
});

test('downscaling keeps a face’s colours where they are', () => {
  const history = createFaceHistory();
  const face = flat(0xff0000ff);
  // The bottom half another colour.
  face.fill(0xff00ff00, (FACE_SIZE * FACE_SIZE) / 2);
  history.record(0, face);
  const seen = history.at(0);
  expect(seen?.at(0)).toBe(0xff0000ff);
  expect(seen?.at(-1)).toBe(0xff00ff00);
});

test('cleared, it holds nothing', () => {
  const history = createFaceHistory();
  history.record(0, flat(0xff000011));
  history.clear();
  expect(history.at(0)).toBeNull();
});
