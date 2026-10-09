import { expect, test, vi } from 'vitest';
import type { Detector } from './face-detector';
import { createFrameStep } from './framer';
import type { Rect } from './framing';

const video = (w = 640, h = 480) => ({ videoWidth: w, videoHeight: h }) as HTMLVideoElement;
const face = { x: 280, y: 200, w: 80, h: 100 };
function harness() {
  const rects: Rect[] = [];
  const s = createFrameStep((_, r) => rects.push({ ...r }));
  return { s, rects };
}

test('without a detector every frame draws the centred square', () => {
  const { s, rects } = harness();
  s.step(video(), 0);
  s.step(video(), 40);
  expect(rects).toEqual([
    { x: 80, y: 0, size: 480 },
    { x: 80, y: 0, size: 480 },
  ]);
});

test('detection runs at most once a second and gets the video and time', () => {
  const { s } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  const v = video();
  for (const t of [0, 250, 500, 999, 1000, 1500, 1999, 2000]) {
    s.step(v, t);
  }
  expect(detect.mock.calls).toEqual([
    [v, 0],
    [v, 1000],
    [v, 2000],
  ]);
});

test('a detector that throws is dropped and the crop returns to centre', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { s, rects } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  for (let t = 0; t <= 2000; t += 40) {
    s.step(video(), t);
  }
  detect.mockImplementation(() => {
    throw new Error('context lost');
  });
  for (let t = 2040; t <= 12_000; t += 40) {
    s.step(video(), t);
  }
  expect(detect).toHaveBeenCalledTimes(4); // good at 0, 1000, 2000; throws at 3000
  expect(warn).toHaveBeenCalledTimes(1);
  const last = rects.at(-1) as Rect;
  expect(last.size).toBeCloseTo(480, 1);
  expect(last.x).toBeCloseTo(80, 1);
  warn.mockRestore();
});

test('step builds framing from the real video size', () => {
  const { s, rects } = harness();
  s.step(video(480, 640), 0);
  expect(rects.at(-1)).toEqual({ x: 0, y: 80, size: 480 });
  s.step(video(1280, 720), 40);
  expect(rects.at(-1)).toEqual({ x: 280, y: 0, size: 720 });
});

test('step skips frames before the video has a size', () => {
  const { s, rects } = harness();
  const detect = vi.fn<Detector['detect']>(() => face);
  s.setDetector({ detect });
  s.step(video(0, 0), 0);
  expect(rects).toEqual([]);
  expect(detect).not.toHaveBeenCalled();
});
