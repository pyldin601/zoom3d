import { expect, test, vi } from 'vitest';
import { largestBox, loadFaceDetector } from './face-detector';

const det = (originX: number, originY: number, width: number, height: number) => ({
  boundingBox: { originX, originY, width, height },
});

test('largestBox picks the biggest face and maps it to a Box', () => {
  expect(largestBox([det(0, 0, 20, 20), det(100, 50, 80, 90), det(300, 0, 40, 40)], 640, 480)).toEqual({
    x: 100,
    y: 50,
    w: 80,
    h: 90,
  });
});

test('largestBox keeps the mouth keypoint (index 3), converted to source pixels', () => {
  const kp = (x: number, y: number) => ({ x, y });
  const withKeypoints = {
    ...det(100, 50, 80, 90),
    keypoints: [kp(0.1, 0.1), kp(0.2, 0.1), kp(0.15, 0.2), kp(0.5, 0.25), kp(0, 0.1), kp(0.3, 0.1)],
  };
  expect(largestBox([withKeypoints], 640, 480)).toEqual({ x: 100, y: 50, w: 80, h: 90, mouth: { x: 320, y: 120 } });
});

test('largestBox is null with no usable detections', () => {
  expect(largestBox([], 640, 480)).toBeNull();
  expect(largestBox([{}], 640, 480)).toBeNull();
});

test('a failed load resolves null with one warning', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await loadFaceDetector({ load: () => Promise.reject(new Error('404')) })).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test('GPU init failure retries once on CPU', async () => {
  const delegates: string[] = [];
  const detector = { detectForVideo: () => ({ detections: [det(1, 2, 3, 4)] }) };
  const load = async () =>
    ({
      FilesetResolver: { forVisionTasks: async (path: string) => ({ path }) },
      FaceDetector: {
        createFromOptions: async (_: unknown, o: { baseOptions: { delegate: string } }) => {
          delegates.push(o.baseOptions.delegate);
          if (o.baseOptions.delegate === 'GPU') {
            throw new Error('no webgl');
          }
          return detector;
        },
      },
    }) as never;
  const d = await loadFaceDetector({ load });
  expect(delegates).toEqual(['GPU', 'CPU']);
  expect(d?.detect({ videoWidth: 640, videoHeight: 480 } as HTMLVideoElement, 0)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
});
